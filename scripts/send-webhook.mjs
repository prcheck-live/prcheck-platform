// Sends a signed GitHub pull_request webhook to the engine, exactly as GitHub would.
//   node scripts/send-webhook.mjs <url> <action> <repo full name> <pr> <head sha> <head ref> <base ref> <title>
import { createHmac, randomUUID } from 'crypto';

const [url, action, repo, pr, sha, headRef, baseRef, title] = process.argv.slice(2);
const secret = process.env.WEBHOOK_SECRET;
if (!secret) { console.error('WEBHOOK_SECRET is required'); process.exit(2); }

const body = JSON.stringify({
  action,
  number: Number(pr),
  pull_request: { number: Number(pr), title, head: { sha, ref: headRef }, base: { ref: baseRef }, state: 'open' },
  repository: { full_name: repo },
  sender: { login: 'vendorpay-dev' },
});
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-github-event': 'pull_request',
    'x-github-delivery': randomUUID(),
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
  },
  body,
});
const out = await res.text();
console.log(res.status, out);
if (res.status >= 300) process.exit(1);
