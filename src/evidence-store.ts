import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from './config';
import { pool } from './db';

/**
 * Write-once, content-addressed store. Local stand-in for S3 with Object Lock
 * (compliance mode): an object's name is its SHA-256, it is never overwritten,
 * and the database only keeps the digest that points to it.
 */
export async function put(kind: 'context' | 'evidence' | 'report', content: string): Promise<string> {
  const hex = createHash('sha256').update(content).digest('hex');
  const digest = `sha256:${hex}`;
  const dir = join(config.evidence_store, hex.slice(0, 2));
  const file = join(dir, `${hex}.${kind === 'report' ? 'md' : 'json'}`);
  mkdirSync(dir, { recursive: true });
  if (existsSync(file)) {
    if (readFileSync(file, 'utf8') !== content) throw new Error(`Evidence store corruption at ${digest}`);
  } else {
    writeFileSync(file, content, { mode: 0o444 });
    chmodSync(file, 0o444);
  }
  await pool.query('INSERT INTO evidence_objects (digest, kind, path, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT (digest) DO NOTHING',
    [digest, kind, file, Buffer.byteLength(content)]);
  return digest;
}

export function get(digest: string): string | null {
  const hex = digest.replace(/^sha256:/, '');
  for (const ext of ['json', 'md']) {
    const f = join(config.evidence_store, hex.slice(0, 2), `${hex}.${ext}`);
    if (existsSync(f)) {
      const content = readFileSync(f, 'utf8');
      if (createHash('sha256').update(content).digest('hex') !== hex) throw new Error(`Evidence ${digest} failed its integrity check`);
      return content;
    }
  }
  return null;
}
