/**
 * Members: the people who use QIVVRA, managed by the Platform Admin.
 * Each member has one system role (what they can do), optional Authority tags
 * (which rules they own) and the applications they work on (what they see).
 * Changes apply to the member's very next request, and are written to the platform audit log.
 */
import express, { Request, Response, Router } from 'express';
import { ACCOUNTS, AUTHORITIES, hashPassword, loadMembers, requirePerm, SYS_ROLES, SysRole } from './auth';
import { config } from './config';
import { pool } from './db';

export const members = Router();
members.use(express.json({ limit: '50kb' }));
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'INTERNAL', message: String(e?.message ?? e) }); });
const audit = (actor: string, action: string, target: string, data: object = {}) =>
  pool.query('INSERT INTO platform_audit (actor, action, target, data) VALUES ($1,$2,$3,$4)', [actor, action, target, data]);

const view = (m: typeof ACCOUNTS[number]) => ({
  email: m.email, name: m.name, designation: m.role, sysRole: m.sysRole, authorities: m.auth, apps: m.apps,
  status: m.status, lastSignIn: m.lastSignIn ?? null, createdBy: m.createdBy, updatedAt: m.updatedAt,
});
const appList = () => Object.values(config.repositories).map((r) => ({ key: r.key, name: r.app ?? r.key, github: r.github }));

members.get('/', requirePerm('admin'), (_req, res) => res.json({ members: ACCOUNTS.map(view), applications: appList(), roles: SYS_ROLES, authorities: AUTHORITIES }));

interface Input { email?: string; name?: string; designation?: string; sysRole?: string; authorities?: string[]; allApps?: boolean; apps?: string[]; password?: string }

/** Checks a member's settings; returns field errors, or the cleaned values. */
function validate(b: Input, creating: boolean) {
  const errors: Record<string, string> = {};
  const email = String(b.email ?? '').trim().toLowerCase();
  const name = String(b.name ?? '').trim(), designation = String(b.designation ?? '').trim();
  const sysRole = b.sysRole as SysRole;
  const authorities = [...new Set((b.authorities ?? []).map(String))];
  const apps = [...new Set((b.apps ?? []).map(String))];
  const allApps = !!b.allApps;
  if (creating) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = 'Enter a work email like name@company.com';
    else if (ACCOUNTS.some((a) => a.email === email)) errors.email = 'This person is already a member';
  }
  if (name.length < 2 || name.length > 80) errors.name = 'Enter the full name';
  if (designation.length < 2 || designation.length > 80) errors.designation = 'Enter the designation, for example Finance Controller';
  if (!SYS_ROLES.includes(sysRole)) errors.sysRole = 'Choose a role';
  if (authorities.some((x) => !AUTHORITIES.includes(x))) errors.authorities = 'Unknown authority';
  if (sysRole === 'Admin') {
    if (authorities.length) errors.authorities = 'A Platform Admin configures QIVVRA and cannot own rules';
    if (allApps || apps.length) errors.apps = 'A Platform Admin sees no change evidence, so has no applications';
  } else {
    const unknown = apps.filter((k) => !config.repositories[k]);
    if (unknown.length) errors.apps = `Not onboarded: ${unknown.join(', ')}`;
    else if (!allApps && !apps.length) errors.apps = 'Choose at least one application, or all applications';
  }
  if (creating || b.password) {
    const pw = String(b.password ?? '');
    if (pw.length < 10 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) errors.password = 'At least 10 characters, with letters and digits';
  }
  return { errors, value: { email, name, designation, sysRole, authorities: sysRole === 'Admin' ? [] : authorities, allApps: sysRole !== 'Admin' && allApps, apps: sysRole === 'Admin' || allApps ? [] : apps, password: b.password ? String(b.password) : '' } };
}
const activeAdmins = (except?: string) => ACCOUNTS.filter((a) => a.sysRole === 'Admin' && a.status === 'active' && a.email !== except).length;

members.post('/', requirePerm('admin'), handle(async (req, res) => {
  const { errors, value: v } = validate(req.body ?? {}, true);
  if (Object.keys(errors).length) return res.status(422).json({ error: 'INVALID', errors });
  await pool.query(`INSERT INTO members (email, name, designation, sys_role, authorities, all_apps, apps, password_hash, created_by, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, [v.email, v.name, v.designation, v.sysRole, v.authorities, v.allApps, v.apps, hashPassword(v.password), req.user!.email]);
  await audit(req.user!.email, 'member.added', v.email, { role: v.sysRole, authorities: v.authorities, apps: v.allApps ? 'all' : v.apps });
  await loadMembers();
  res.status(201).json({ member: view(ACCOUNTS.find((a) => a.email === v.email)!) });
}));

members.put('/:email', requirePerm('admin'), handle(async (req, res) => {
  const m = ACCOUNTS.find((a) => a.email === req.params.email);
  if (!m) return res.status(404).json({ error: 'NOT_FOUND' });
  const { errors, value: v } = validate({ ...req.body, email: m.email }, false);
  if (m.email === req.user!.email && v.sysRole !== 'Admin') errors.sysRole = 'You cannot remove your own Admin role';
  if (m.sysRole === 'Admin' && v.sysRole !== 'Admin' && m.status === 'active' && !activeAdmins(m.email)) errors.sysRole = 'QIVVRA needs at least one active Platform Admin';
  if (Object.keys(errors).length) return res.status(422).json({ error: 'INVALID', errors });
  await pool.query(`UPDATE members SET name = $2, designation = $3, sys_role = $4, authorities = $5, all_apps = $6, apps = $7, updated_by = $8, updated_at = now()
    ${v.password ? ', password_hash = $9' : ''} WHERE email = $1`,
  [m.email, v.name, v.designation, v.sysRole, v.authorities, v.allApps, v.apps, req.user!.email, ...(v.password ? [hashPassword(v.password)] : [])]);
  const changed = Object.entries({ role: [m.sysRole, v.sysRole], authorities: [m.auth.join(','), v.authorities.join(',')], apps: [m.apps === 'all' ? 'all' : m.apps.join(','), v.allApps ? 'all' : v.apps.join(',')] })
    .filter(([, [a, b]]) => a !== b).map(([k, [a, b]]) => `${k}: ${a || '—'} → ${b || '—'}`);
  await audit(req.user!.email, 'member.updated', m.email, { changes: changed, passwordReset: !!v.password });
  await loadMembers();
  res.json({ member: view(ACCOUNTS.find((a) => a.email === m.email)!) });
}));

/** Deactivate or reactivate. Deactivated members cannot sign in, and their open sessions stop working at once. Nothing is deleted. */
members.post('/:email/status', requirePerm('admin'), handle(async (req, res) => {
  const m = ACCOUNTS.find((a) => a.email === req.params.email);
  if (!m) return res.status(404).json({ error: 'NOT_FOUND' });
  const status = req.body?.status;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'BAD_STATUS' });
  if (status === 'disabled' && m.email === req.user!.email) return res.status(422).json({ error: 'INVALID', message: 'You cannot deactivate yourself' });
  if (status === 'disabled' && m.sysRole === 'Admin' && !activeAdmins(m.email)) return res.status(422).json({ error: 'INVALID', message: 'QIVVRA needs at least one active Platform Admin' });
  await pool.query('UPDATE members SET status = $2, updated_by = $3, updated_at = now() WHERE email = $1', [m.email, status, req.user!.email]);
  await audit(req.user!.email, status === 'disabled' ? 'member.deactivated' : 'member.reactivated', m.email);
  await loadMembers();
  res.json({ member: view(ACCOUNTS.find((a) => a.email === m.email)!) });
}));
