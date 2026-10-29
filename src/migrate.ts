import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pool } from './db';

export async function migrate() {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const dir = join(__dirname, '..', 'db');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await pool.query('BEGIN');
    try {
      await pool.query(readFileSync(join(dir, f), 'utf8'));
      await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await pool.query('COMMIT');
      console.log(`applied ${f}`);
    } catch (e) { await pool.query('ROLLBACK'); throw e; }
  }
}

if (require.main === module) migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
