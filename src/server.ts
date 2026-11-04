import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { access, loadMembers, requireUser, seesApp } from './auth';
import { config, repoByGithubName } from './config';
import { pool } from './db';
import { get } from './evidence-store';
import { migrate } from './migrate';
import { createAssessment, enqueue } from './pipeline';
import { loadApplications } from './applications';
import { ui } from './ui';

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
  if (repo.status === 'paused') return res.status(202).json({ ignored: `${repo.app ?? repo.key} is paused in QIVVRA` });
  const pr = payload.pull_request;
  const request = {
    repo, prNumber: pr.number, headSha: String(pr.head.sha), baseRef: pr.base.ref, headRef: pr.head.ref, title: pr.title,
    trigger: `github:${delivery}`,
  };
  const id = await createAssessment(request);
  enqueue(id, request);
  res.status(202).json({ assessmentId: id, url: `${config.server.public_url}/assessments/${id}` });
} catch (e) { next(e); } });

/** Signed-in users, or internal tools (CLI, demo scripts) holding the webhook secret. */
function requireUserOrInternal(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.header('x-qivvra-key');
  if (key && process.env.WEBHOOK_SECRET && key.length === process.env.WEBHOOK_SECRET.length &&
      timingSafeEqual(Buffer.from(key), Buffer.from(process.env.WEBHOOK_SECRET))) return next();
  return requireUser(req, res, () => (req.user && access(req.user).scope === 'none'
    ? res.status(403).json({ error: 'FORBIDDEN', message: 'Admins do not see change evidence' }) : next()));
}
const visible = (req: express.Request, repository: string) => !req.user || seesApp(req.user, repository);

app.get('/api/assessments', requireUserOrInternal, async (req, res) => {
  const args: unknown[] = [];
  let where = '';
  if (typeof req.query.pr === 'string') { args.push(Number(req.query.pr)); where = 'WHERE pr_number = $1'; }
  const r = await pool.query(`SELECT * FROM assessments ${where} ORDER BY created_at DESC LIMIT 100`, args);
  res.json({ assessments: r.rows.filter((a) => visible(req, a.repository)) });
});

app.get('/api/assessments/:id', requireUserOrInternal, async (req, res) => {
  const a = await pool.query('SELECT * FROM assessments WHERE id = $1', [req.params.id]);
  if (!a.rowCount || !visible(req, a.rows[0].repository)) return res.status(404).json({ error: 'NOT_FOUND' });
  const [obligations, events] = await Promise.all([
    pool.query('SELECT * FROM obligation_results WHERE assessment_id = $1 ORDER BY (state = \'SUPPORTED\'), obligation_id', [req.params.id]),
    pool.query('SELECT step, message, at FROM assessment_events WHERE assessment_id = $1 ORDER BY id', [req.params.id]),
  ]);
  res.json({ assessment: a.rows[0], obligations: obligations.rows, events: events.rows });
});

app.get('/api/evidence/:digest', requireUserOrInternal, async (req, res) => {
  const owner = await pool.query('SELECT repository FROM assessments WHERE $1 IN (context_digest, evidence_digest, report_digest) LIMIT 1', [req.params.digest]);
  if (!owner.rowCount || !visible(req, owner.rows[0].repository)) return res.status(404).json({ error: 'NOT_FOUND' });
  try {
    const content = get(req.params.digest);
    if (content === null) return res.status(404).json({ error: 'NOT_FOUND' });
    res.type(content.startsWith('{') ? 'application/json' : 'text/markdown').send(content);
  } catch (e) { res.status(500).json({ error: 'INTEGRITY_CHECK_FAILED', message: String(e) }); }
});

app.use('/api/ui', ui);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: err.message });
});
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e));

app.get('/health', (_req, res) => res.json({ ok: true }));

/* The UI is the approved prototype (ui/prototype.html) with its demo data replaced by
   the live layer (public/live.js). The prototype file itself is never edited by hand here. */
function uiPage(): string {
  const html = readFileSync(join(__dirname, '..', 'ui', 'prototype.html'), 'utf8');
  const boot = html.lastIndexOf('{ const saved = sess(true);');
  if (boot < 0) throw new Error('ui/prototype.html: start-up block not found; update the live layer');
  const end = html.indexOf('\n', boot);
  return html.slice(0, boot) + '/* start-up handled by live.js */' + html.slice(end)
    .replace('</body>', '<script src="/live.js"></script>\n</body>');
}
const UI_HTML = uiPage();
app.use(express.static(join(__dirname, '..', 'public'), { index: false }));
app.get(['/', '/assessments/:id'], (_req, res) => res.type('html').send(UI_HTML));

if (require.main === module) {
  migrate().then(loadApplications).then(loadMembers).then(() => {
    app.listen(config.server.port, () => console.log(`QIVVRA engine on ${config.server.public_url}`));
  }).catch((e) => { console.error(e); process.exit(1); });
}
export { app };
