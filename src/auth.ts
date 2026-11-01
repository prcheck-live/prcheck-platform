/**
 * Sign-in and role-based access for the QIVVRA UI.
 *
 * Demo identities match the prototype exactly. Every rule here is enforced on the
 * server: hiding a button in the UI is a convenience, never the control.
 * Replace ACCOUNTS with your identity provider (OIDC / SAML) in production.
 */
import type { NextFunction, Request, Response } from 'express';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export type SysRole = 'Admin' | 'Assurance Lead' | 'Contributor' | 'Viewer';
export interface Account {
  email: string; short: string; name: string; role: string; tagRole: string; sysRole: SysRole;
  auth: string[]; initials: string; job: string;
}

export const ACCOUNTS: Account[] = [
  { email: 'a.rao@qivvra.demo', short: 'A. Rao', name: 'Anika Rao', role: 'QE / Assurance Lead', tagRole: 'Assurance Lead', sysRole: 'Assurance Lead', auth: [], initials: 'AR', job: 'Runs assurance, chases gaps, explains blocks' },
  { email: 'r.das@qivvra.demo', short: 'R. Das', name: 'Rohan Das', role: 'Tech Lead, VendorPay', tagRole: 'Tech Lead', sysRole: 'Contributor', auth: [], initials: 'RD', job: 'Sees exactly what failed and fixes it' },
  { email: 'm.iyer@qivvra.demo', short: 'M. Iyer', name: 'Meera Iyer', role: 'Finance Controller', tagRole: 'Finance Controller', sysRole: 'Viewer', auth: ['Finance'], initials: 'MI', job: 'Owns finance rules and exceptions' },
  { email: 's.qureshi@qivvra.demo', short: 'S. Qureshi', name: 'Sana Qureshi', role: 'Security Architect', tagRole: 'Security Architect', sysRole: 'Contributor', auth: ['Security'], initials: 'SQ', job: 'Reviews security obligations and evidence' },
  { email: 'k.shah@qivvra.demo', short: 'K. Shah', name: 'Karan Shah', role: 'Release Manager', tagRole: 'Release Manager', sysRole: 'Viewer', auth: [], initials: 'KS', job: 'Knows what can ship, and its limits' },
  { email: 'p.nair@qivvra.demo', short: 'P. Nair', name: 'Priya Nair', role: 'Platform Admin', tagRole: 'Platform Admin', sysRole: 'Admin', auth: [], initials: 'PN', job: 'Connects tools, manages users and profiles' },
];

// Demo credentials, as shown on the sign-in page. Stored as a scrypt hash, compared in constant time.
const SALT = Buffer.from('qivvra-demo-salt');
const PASSWORD_HASH = scryptSync(process.env.QIVVRA_DEMO_PASSWORD ?? 'Qivvra@2026', SALT, 32);
const DEMO_CODE = process.env.QIVVRA_DEMO_CODE ?? '246810';

export function checkCredentials(email: string, password: string, code: string): Account | null {
  const acct = ACCOUNTS.find((a) => a.email === String(email).trim().toLowerCase());
  const ok = timingSafeEqual(scryptSync(String(password), SALT, 32), PASSWORD_HASH);
  if (!acct || !ok) return null;
  if (String(code) !== DEMO_CODE) return null;
  return acct;
}
export function checkPassword(email: string, password: string): boolean {
  const acct = ACCOUNTS.find((a) => a.email === String(email).trim().toLowerCase());
  return !!acct && timingSafeEqual(scryptSync(String(password), SALT, 32), PASSWORD_HASH);
}

/* ---------- Access model (same as the prototype) ---------- */
export const CHANGE_ROUTES = ['command', 'change', 'revisions', 'graph', 'obligations', 'gaps', 'evidence', 'case'];
export function access(a: Account) {
  if (a.sysRole === 'Admin') return { routes: ['home', 'integrations', 'profiles', 'org-settings'], scope: 'none' };
  if (a.sysRole === 'Assurance Lead') return { routes: ['home', ...CHANGE_ROUTES, 'integrations', 'profiles', 'org-settings'], scope: 'all' };
  if (a.sysRole === 'Contributor') return { routes: ['home', ...CHANGE_ROUTES, 'org-settings'], scope: a.auth.includes('Security') ? 'all' : 'VendorPay' };
  return { routes: ['home', ...CHANGE_ROUTES, 'org-settings'], scope: 'all' };
}
export const PERMS: Record<string, SysRole[]> = { run: ['Assurance Lead'], requestRerun: ['Contributor'], admin: ['Admin'], platform: ['Admin', 'Assurance Lead'] };
export const can = (a: Account, perm: string) => (PERMS[perm] ?? []).includes(a.sysRole);
export const seesApp = (a: Account, app: string) => { const s = access(a).scope; return s === 'all' || s === app; };

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
    return ACCOUNTS.find((a) => a.email === e) ?? null;
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
