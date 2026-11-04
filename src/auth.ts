/**
 * Sign-in and role-based access for the QIVVRA UI.
 *
 * Members live in the database and are managed by the Platform Admin. Every rule
 * here is enforced on the server: hiding a button in the UI is a convenience, never
 * the control. In production, sign-in comes from your identity provider (OIDC / SAML).
 */
import type { NextFunction, Request, Response } from 'express';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export type SysRole = 'Admin' | 'Assurance Lead' | 'Contributor' | 'Viewer';
export const SYS_ROLES: SysRole[] = ['Admin', 'Assurance Lead', 'Contributor', 'Viewer'];
export const AUTHORITIES = ['Finance', 'Security', 'Compliance', 'Platform'];
export interface Account {
  email: string; short: string; name: string; role: string; tagRole: string; sysRole: SysRole;
  auth: string[]; initials: string; job: string;
  /** Applications (keys) this member works on, or 'all' (every application, including future ones). */
  apps: 'all' | string[];
  status: 'active' | 'disabled';
  passwordHash?: string;
  lastSignIn?: string | null; createdBy?: string; updatedAt?: string;
}

/** The demo members, created the first time the engine starts with an empty members table. */
const SEED: Array<Omit<Account, 'short' | 'initials' | 'tagRole' | 'job' | 'status'> & { job: string }> = [
  { email: 'a.rao@qivvra.demo', name: 'Anika Rao', role: 'QE / Assurance Lead', sysRole: 'Assurance Lead', auth: [], apps: 'all', job: 'Runs assurance, chases gaps, explains blocks' },
  { email: 'r.das@qivvra.demo', name: 'Rohan Das', role: 'Tech Lead, VendorPay', sysRole: 'Contributor', auth: [], apps: ['vendorpay'], job: 'Sees exactly what failed and fixes it' },
  { email: 'm.iyer@qivvra.demo', name: 'Meera Iyer', role: 'Finance Controller', sysRole: 'Viewer', auth: ['Finance'], apps: 'all', job: 'Owns finance rules and exceptions' },
  { email: 's.qureshi@qivvra.demo', name: 'Sana Qureshi', role: 'Security Architect', sysRole: 'Contributor', auth: ['Security'], apps: 'all', job: 'Reviews security obligations and evidence' },
  { email: 'k.shah@qivvra.demo', name: 'Karan Shah', role: 'Release Manager', sysRole: 'Viewer', auth: [], apps: 'all', job: 'Knows what can ship, and its limits' },
  { email: 'v.bose@qivvra.demo', name: 'Vikram Bose', role: 'Compliance Officer', sysRole: 'Viewer', auth: ['Compliance'], apps: 'all', job: 'Owns audit-trail rules and compliance exceptions' },
  { email: 'a.pillai@qivvra.demo', name: 'Arjun Pillai', role: 'Platform Engineering Lead', sysRole: 'Contributor', auth: ['Platform'], apps: 'all', job: 'Owns build, deploy and environment rules' },
  { email: 'p.nair@qivvra.demo', name: 'Priya Nair', role: 'Platform Admin', sysRole: 'Admin', auth: [], apps: [], job: 'Connects tools, manages users and profiles' },
];

/** What each role is for, shown next to a member. */
export const ROLE_JOB: Record<SysRole, string> = {
  'Admin': 'Connects tools, manages members and applications',
  'Assurance Lead': 'Runs assurance, chases gaps, explains blocks',
  'Contributor': 'Sees exactly what failed and fixes it',
  'Viewer': 'Reads changes, evidence and release readiness',
};

/** Members currently loaded from the database. Kept in memory so every request can check a session quickly. */
export const ACCOUNTS: Account[] = [];

const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const shortOf = (name: string) => { const p = name.trim().split(/\s+/); return p.length > 1 ? `${p[0][0]}. ${p.slice(1).join(' ')}` : p[0]; };
const tagOf = (designation: string) => designation.split(',')[0].trim();

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}
function verifyPassword(a: Account | undefined, pw: string): boolean {
  // Always do the work, so a wrong email and a wrong password take the same time.
  const [, salt, hash] = (a?.passwordHash ?? `scrypt$${'0'.repeat(32)}$${'0'.repeat(64)}`).split('$');
  const got = scryptSync(String(pw), Buffer.from(salt, 'hex'), 32);
  return !!a && timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

export function rowToAccount(r: any): Account {
  return {
    email: r.email, name: r.name, short: shortOf(r.name), initials: initialsOf(r.name), role: r.designation, tagRole: tagOf(r.designation),
    sysRole: r.sys_role, auth: r.authorities ?? [], apps: r.all_apps ? 'all' : (r.apps ?? []), status: r.status, passwordHash: r.password_hash,
    job: ROLE_JOB[r.sys_role as SysRole], lastSignIn: r.last_sign_in, createdBy: r.created_by, updatedAt: r.updated_at,
  };
}

/** Loads members into memory; creates the demo members on first start. */
export async function loadMembers() {
  const { pool } = await import('./db');
  const n = (await pool.query('SELECT count(*)::int AS n FROM members')).rows[0].n;
  if (!n) {
    const demo = hashPassword(process.env.QIVVRA_DEMO_PASSWORD ?? 'Qivvra@2026');
    for (const m of SEED) await pool.query(`INSERT INTO members (email, name, designation, sys_role, authorities, all_apps, apps, password_hash, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'seed','seed')`, [m.email, m.name, m.role, m.sysRole, m.auth, m.apps === 'all', m.apps === 'all' ? [] : m.apps, demo]);
    console.log(`created ${SEED.length} demo members`);
  }
  const rows = (await pool.query('SELECT * FROM members ORDER BY created_at, email')).rows;
  ACCOUNTS.splice(0, ACCOUNTS.length, ...rows.map(rowToAccount));
}

// Demo second factor until the identity provider is connected.
const DEMO_CODE = process.env.QIVVRA_DEMO_CODE ?? '246810';
const findActive = (email: string) => ACCOUNTS.find((a) => a.email === String(email).trim().toLowerCase() && a.status === 'active');

export function checkCredentials(email: string, password: string, code: string): Account | null {
  const acct = findActive(email);
  if (!verifyPassword(acct, password)) return null;
  if (String(code) !== DEMO_CODE) return null;
  return acct!;
}
export function checkPassword(email: string, password: string): boolean {
  return verifyPassword(findActive(email), password);
}

/* ---------- Access model (same as the prototype) ---------- */
export const CHANGE_ROUTES = ['command', 'change', 'revisions', 'graph', 'obligations', 'gaps', 'evidence', 'case'];
/** scope: 'none' (Admin), 'all', or the application keys the member works on. */
export function access(a: Account): { routes: string[]; scope: 'none' | 'all' | string[] } {
  const scope = a.sysRole === 'Admin' ? 'none' : a.apps === 'all' ? 'all' : a.apps;
  if (a.sysRole === 'Admin') return { routes: ['home', 'integrations', 'onboard', 'profiles', 'org-settings'], scope };
  if (a.sysRole === 'Assurance Lead') return { routes: ['home', ...CHANGE_ROUTES, 'integrations', 'profiles', 'org-settings'], scope };
  return { routes: ['home', ...CHANGE_ROUTES, 'org-settings'], scope };
}
export const PERMS: Record<string, SysRole[]> = { run: ['Assurance Lead'], requestRerun: ['Contributor'], admin: ['Admin'], platform: ['Admin', 'Assurance Lead'] };
export const can = (a: Account, perm: string) => (PERMS[perm] ?? []).includes(a.sysRole);
/** Whether the member works on this application (by repository key). */
export const seesApp = (a: Account, repoKey: string) => { const s = access(a).scope; return s === 'all' || (Array.isArray(s) && s.includes(repoKey)); };

/* ---------- Session cookie: base64url(payload).hmac ---------- */
const SECRET = process.env.QIVVRA_SESSION_SECRET ?? randomBytes(32).toString('hex');
const COOKIE = 'qivvra_session';
const TTL_HOURS = 12;

export function issueSession(res: Response, a: Account, remember: boolean) {
  const payload = Buffer.from(JSON.stringify({ e: a.email, x: Date.now() + TTL_HOURS * 3600e3 })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  res.cookie(COOKIE, `${payload}.${sig}`, {
    httpOnly: true, sameSite: 'lax', secure: process.env.QIVVRA_PUBLIC_URL?.startsWith('https://') ?? false, path: '/',
    ...(remember ? { maxAge: TTL_HOURS * 3600e3 } : {}),
  });
}
export function clearSession(res: Response) { res.clearCookie(COOKIE, { path: '/' }); }

function readSession(req: Request): Account | null {
  const raw = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Date.now() > x) return null;
    return ACCOUNTS.find((a) => a.email === e && a.status === 'active') ?? null;
  } catch { return null; }
}

declare module 'express-serve-static-core' { interface Request { user?: Account } }

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const u = readSession(req);
  if (!u) return res.status(401).json({ error: 'SIGN_IN_REQUIRED' });
  req.user = u;
  next();
}
export const requirePerm = (perm: string) => (req: Request, res: Response, next: NextFunction) =>
  req.user && can(req.user, perm) ? next() : res.status(403).json({ error: 'FORBIDDEN', message: `Needs the ${PERMS[perm]?.join(' or ')} role` });
