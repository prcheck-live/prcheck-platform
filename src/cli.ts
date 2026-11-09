/**
 * Runs one assessment without a webhook, e.g. to re-assess a commit by hand.
 *   npm run assess -- --repo vendorpay --pr 482 --sha 900652c --base main --head-ref feature/VP-184-bank-change --title "VP-184: ..."
 */
import { config } from './config';
import { pool } from './db';
import { migrate } from './migrate';
import { createAssessment, runAssessment } from './pipeline';
import { loadApplications } from './applications';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

(async () => {
  await migrate();
  await loadApplications();
  const { loadMembers } = await import('./auth'); await loadMembers();
  const repo = config.repositories[opt('repo') ?? 'vendorpay'];
  if (!repo || !opt('pr') || !opt('sha')) { console.error('Need --repo, --pr and --sha'); process.exit(2); }
  const req = {
    repo, prNumber: Number(opt('pr')), headSha: opt('sha')!, baseRef: opt('base') ?? repo.base_branch,
    headRef: opt('head-ref'), title: opt('title'), trigger: 'cli',
  };
  const id = await createAssessment(req);
  const result = await runAssessment(id, req);
  console.log(`\n${id}: ${result.disposition} (${result.because})`);
  await pool.end();
})();
