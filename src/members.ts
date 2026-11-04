/**
 * Members: the people who use QIVVRA, managed by the Platform Admin.
 * Each member has one system role (what they can do), optional Authority tags
 * (which rules they own) and the applications they work on (what they see).
 * Changes apply to the member's very next request, and are written to the platform audit log.
 */
import express, { Request, Response, Router } from 'express';
import { randomBytes } from 'crypto';
import { ACCOUNTS, AUTHORITIES, hashPassword, loadMembers, requirePerm, SYS_ROLES, SysRole } from './auth';
import { config } from './config';
import { pool } from './db';

export const members = Router();
members.use(express.json({ limit: '1mb' }));
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

/* ---------- Bulk import from CSV ----------
 * The browser parses the file and sends its rows; the engine validates every row
 * again. dryRun: true returns what would happen per row; dryRun: false applies the
 * valid rows and skips the rest. Members are never deactivated by an import.
 */
const ROLE_ALIASES: Record<string, SysRole> = { 'assurance lead': 'Assurance Lead', lead: 'Assurance Lead', contributor: 'Contributor', viewer: 'Viewer', admin: 'Admin', 'platform admin': 'Admin' };
interface ImportRow { line: number; email?: string; name?: string; designation?: string; role?: string; authorities?: string; applications?: string; password?: string }
const tempPassword = () => 'Qv-' + randomBytes(6).toString('base64url') + '7a';

function resolveRow(r: ImportRow) {
  const errors: Record<string, string> = {};
  const role = ROLE_ALIASES[String(r.role ?? '').trim().toLowerCase()];
  if (!role) errors.sysRole = `Role must be Assurance Lead, Contributor, Viewer or Platform Admin (got "${r.role ?? ''}")`;
  const split = (v?: string) => String(v ?? '').split(/[;|]/).map((x) => x.trim()).filter(Boolean);
  const authorities = split(r.authorities).map((x) => AUTHORITIES.find((a) => a.toLowerCase() === x.toLowerCase()) ?? x);
  const appTokens = split(r.applications);
  const allApps = appTokens.some((x) => ['all', '*'].includes(x.toLowerCase()));
  const apps: string[] = [];
  for (const t of appTokens.filter((x) => !['all', '*'].includes(x.toLowerCase()))) {
    const hit = Object.values(config.repositories).find((x) => x.key.toLowerCase() === t.toLowerCase() || (x.app ?? '').toLowerCase() === t.toLowerCase());
    apps.push(hit ? hit.key : t);
  }
  return { errors, input: { email: r.email, name: r.name, designation: r.designation, sysRole: role ?? String(r.role ?? ''), authorities, allApps, apps, password: String(r.password ?? '').trim() } };
}

members.post('/import', requirePerm('admin'), handle(async (req, res) => {
  const rows: ImportRow[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const dryRun = req.body?.dryRun !== false;
  if (!rows.length) return res.status(400).json({ error: 'EMPTY', message: 'The file has no member rows' });
  if (rows.length > 500) return res.status(400).json({ error: 'TOO_MANY', message: 'Import at most 500 members at a time' });
  const seen = new Map<string, number>();
  const results = rows.map((row) => {
    const email = String(row.email ?? '').trim().toLowerCase();
    const existing = ACCOUNTS.find((a) => a.email === email);
    const { errors: roleErr, input } = resolveRow(row);
    const generate = !existing && !input.password;
    const { errors, value } = validate({ ...input, email, password: generate ? tempPassword() : input.password }, !existing);
    Object.assign(errors, roleErr);
    if (seen.has(email)) errors.email = `Same email as line ${seen.get(email)}`;
    if (email) seen.set(email, row.line);
    if (existing && existing.email === req.user!.email && value.sysRole !== 'Admin') errors.sysRole = 'You cannot remove your own Admin role';
    let action: 'add' | 'update' | 'unchanged' | 'error' = Object.keys(errors).length ? 'error' : existing ? 'update' : 'add';
    const changes: string[] = [];
    if (action === 'update' && existing) {
      const cur = { name: existing.name, designation: existing.role, role: existing.sysRole, authorities: existing.auth.join(';'), applications: existing.apps === 'all' ? 'all' : existing.apps.join(';') };
      const nxt = { name: value.name, designation: value.designation, role: value.sysRole, authorities: value.authorities.join(';'), applications: value.allApps ? 'all' : value.apps.join(';') };
      for (const k of Object.keys(cur) as Array<keyof typeof cur>) if (cur[k] !== nxt[k]) changes.push(`${k}: ${cur[k] || '—'} → ${nxt[k] || '—'}`);
      if (value.password) changes.push('password reset');
      if (!changes.length) action = 'unchanged';
    }
    return { line: row.line, email, name: value.name, action, errors, changes, value, generated: generate ? value.password : null, existing: !!existing };
  });
  // At least one active Admin must remain after the import.
  const demoted = results.filter((r) => r.action === 'update' && r.value.sysRole !== 'Admin' && ACCOUNTS.find((a) => a.email === r.email)?.sysRole === 'Admin').map((r) => r.email);
  if (demoted.length && ACCOUNTS.filter((a) => a.sysRole === 'Admin' && a.status === 'active' && !demoted.includes(a.email)).length + results.filter((r) => r.action === 'add' && r.value.sysRole === 'Admin').length === 0)
    for (const r of results) if (demoted.includes(r.email)) { r.errors.sysRole = 'QIVVRA needs at least one active Platform Admin'; r.action = 'error'; }

  const summary = { add: 0, update: 0, unchanged: 0, error: 0 };
  results.forEach((r) => summary[r.action]++);
  if (!dryRun) {
    for (const r of results) {
      const v = r.value;
      if (r.action === 'add') await pool.query(`INSERT INTO members (email, name, designation, sys_role, authorities, all_apps, apps, password_hash, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, [v.email, v.name, v.designation, v.sysRole, v.authorities, v.allApps, v.apps, hashPassword(v.password), req.user!.email]);
      if (r.action === 'update') await pool.query(`UPDATE members SET name = $2, designation = $3, sys_role = $4, authorities = $5, all_apps = $6, apps = $7, updated_by = $8, updated_at = now()
        ${v.password ? ', password_hash = $9' : ''} WHERE email = $1`, [v.email, v.name, v.designation, v.sysRole, v.authorities, v.allApps, v.apps, req.user!.email, ...(v.password ? [hashPassword(v.password)] : [])]);
    }
    await audit(req.user!.email, 'member.imported', `${summary.add} added, ${summary.update} updated`, {
      added: results.filter((r) => r.action === 'add').map((r) => r.email), updated: results.filter((r) => r.action === 'update').map((r) => ({ email: r.email, changes: r.changes })), skipped: summary.error });
    await loadMembers();
  }
  res.json({ dryRun, summary, results: results.map(({ value, ...r }) => ({ ...r, role: value.sysRole, applications: value.allApps ? 'all' : value.apps, authorities: value.authorities, generated: dryRun ? !!r.generated : r.generated })) });
}));
