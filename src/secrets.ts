/**
 * Encrypts the credentials an Admin enters when onboarding an application
 * (Jira token, repository tokens, the verifiers' test logins).
 *
 * AES-256-GCM with a key derived from PRCHECK_SECRET_KEY. Secrets are decrypted
 * only in the engine's memory and are never sent back to the browser.
 * In production, replace this with your KMS or vault.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

function key(): Buffer {
  const k = process.env.PRCHECK_SECRET_KEY || process.env.WEBHOOK_SECRET;
  if (!k) throw new Error('Set PRCHECK_SECRET_KEY so the engine can store credentials');
  return createHash('sha256').update('prcheck-secrets:' + k).digest();
}

export function seal(values: Record<string, string>): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(values), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function open(sealed: string | null): Record<string, string> {
  if (!sealed) return {};
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8'));
}
