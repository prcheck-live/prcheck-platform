import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { join } from 'path';
import { config, repoByGithubName } from './config';
import { pool } from './db';
import { get } from './evidence-store';
import { migrate } from './migrate';
import { createAssessment, enqueue } from './pipeline';

const app = express();
app.disable('x-powered-by');

/** GitHub signs every delivery with the webhook secret; anything unsigned is rejected. */
function validSignature(body: Buffer, header: string | undefined): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(body).digest('hex'));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

app.post('/webhooks/github', express.raw({ type: 'application/json', limit: '5mb' }), async (req, res, next) => { try {
  if (!validSignature(req.body, req.header('x-hub-signature-256'))) return res.status(401).json({ error: 'INVALID_SIGNATURE' });
  const eventName = req.header('x-github-event') ?? '';
  const delivery = req.header('x-github-delivery') ?? '';
  if (eventName === 'ping') return res.json({ ok: true });
  if (eventName !== 'pull_request') return res.status(202).json({ ignored: `event ${eventName}` });

  // Redelivered webhooks must not start a second assessment.
  const fresh = await pool.query('INSERT INTO webhook_deliveries (delivery_id, event) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING delivery_id', [delivery, eventName]);
  if (!fresh.rowCount) return res.status(200).json({ ignored: 'duplicate delivery' });

  const payload = JSON.parse(req.body.toString('utf8'));
  if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(payload.action)) return res.status(202).json({ ignored: `action ${payload.action}` });
  const repo = repoByGithubName(payload.repository?.full_name ?? '');
  if (!repo) return res.status(202).json({ ignored: `repository ${payload.repository?.full_name} is not onboarded` });
  const pr = payload.pull_request;
  const request = {
    repo, prNumber: pr.number, headSha: String(pr.head.sha), baseRef: pr.base.ref, headRef: pr.head.ref, title: pr.title,
    trigger: `github:${delivery}`,
  };
  const id = await createAssessment(request);
  enqueue(id, request);
  res.status(202).json({ assessmentId: id, url: `${config.server.public_url}/assessments/${id}` });
} catch (e) { next(e); } });

app.get('/api/assessments', async (req, res) => {
  const args: unknown[] = [];
  let where = '';
  if (typeof req.query.pr === 'string') { args.push(Number(req.query.pr)); where = 'WHERE pr_number = $1'; }
  const r = await pool.query(`SELECT * FROM assessments ${where} ORDER BY created_at DESC LIMIT 100`, args);
  res.json({ assessments: r.rows });
});

app.get('/api/assessments/:id', async (req, res) => {
  const a = await pool.query('SELECT * FROM assessments WHERE id = $1', [req.params.id]);
  if (!a.rowCount) return res.status(404).json({ error: 'NOT_FOUND' });
  const [obligations, events] = await Promise.all([
    pool.query('SELECT * FROM obligation_results WHERE assessment_id = $1 ORDER BY (state = \'SUPPORTED\'), obligation_id', [req.params.id]),
    pool.query('SELECT step, message, at FROM assessment_events WHERE assessment_id = $1 ORDER BY id', [req.params.id]),
  ]);
  res.json({ assessment: a.rows[0], obligations: obligations.rows, events: events.rows });
});

app.get('/api/evidence/:digest', (req, res) => {
  try {
    const content = get(req.params.digest);
    if (content === null) return res.status(404).json({ error: 'NOT_FOUND' });
    res.type(content.startsWith('{') ? 'application/json' : 'text/markdown').send(content);
  } catch (e) { res.status(500).json({ error: 'INTEGRITY_CHECK_FAILED', message: String(e) }); }
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: err.message });
});
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(join(__dirname, '..', 'public')));
app.get(['/', '/assessments/:id'], (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'index.html')));

if (require.main === module) {
  migrate().then(() => {
    app.listen(config.server.port, () => console.log(`QIVVRA engine on ${config.server.public_url}`));
  }).catch((e) => { console.error(e); process.exit(1); });
}
export { app };
