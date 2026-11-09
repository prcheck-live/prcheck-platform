#!/usr/bin/env node
// Stand-in for the team's k6 performance run. It loads QE's read APIs as a Finance Ops user and writes a
// k6 --summary-export style JSON, with the build it measured (QE /version) in meta.
//   node perf.mjs <qe-base-url> <out.json> [requests=200] [concurrency=10]
import { writeFileSync } from 'fs';
const [base, out, total = '200', conc = '10'] = process.argv.slice(2);
const login = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.VP_OPS ?? 'neha.joshi', password: process.env.VP_PASSWORD ?? 'VendorPay@2026' }) });
const token = (await login.json()).token;
const version = await (await fetch(new URL('/version', base))).json();
const paths = ['/api/suppliers', '/api/payments', '/api/bank-change-requests', '/health'];
const times = []; let failed = 0, n = 0;
async function worker() {
  while (n < Number(total)) {
    const path = paths[n++ % paths.length], t0 = performance.now();
    try { const r = await fetch(new URL(path, base), { headers: { authorization: `Bearer ${token}` } }); await r.arrayBuffer(); if (r.status >= 400) failed++; } catch { failed++; }
    times.push(performance.now() - t0);
  }
}
await Promise.all(Array.from({ length: Number(conc) }, worker));
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor(p / 100 * times.length))];
const summary = { meta: { tool: 'prcheck-demo-load (k6 summary-export format)', target: base, gitSha: version.gitSha, at: new Date().toISOString() },
  metrics: { http_reqs: { count: times.length }, http_req_failed: { value: failed / times.length },
    http_req_duration: { avg: times.reduce((a, b) => a + b, 0) / times.length, med: pct(50), 'p(90)': pct(90), 'p(95)': pct(95), max: times[times.length - 1] } } };
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`load: ${times.length} requests, p95 ${pct(95).toFixed(1)} ms, failed ${(failed / times.length * 100).toFixed(2)}%`);
