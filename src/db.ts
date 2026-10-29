import { Pool, types } from 'pg';
import { config } from './config';

types.setTypeParser(1082, (v) => v);
export const pool = new Pool({ connectionString: config.database_url, max: 5 });

export async function event(assessmentId: string, step: string, message: string, data: Record<string, unknown> = {}) {
  await pool.query('INSERT INTO assessment_events (assessment_id, step, message, data) VALUES ($1,$2,$3,$4)', [assessmentId, step, message, data]);
  console.log(`[${assessmentId}] ${step.padEnd(11)} ${message}`);
}
