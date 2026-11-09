#!/usr/bin/env node
// Stand-in for the team's static security scan (CodeQL or Semgrep in a real pipeline). It writes the
// same format they do: SARIF 2.1.0, with the commit it scanned in versionControlProvenance.
//   node sast.mjs <repo-dir> <commit> <out.json>
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
const [dir, sha, out] = process.argv.slice(2);
const RULES = [
  { id: 'js/eval', level: 'error', re: /\beval\s*\(|new Function\s*\(/, text: 'Dynamic code evaluation' },
  { id: 'js/sql-injection', level: 'error', re: /\.query\(\s*`[^`]*\$\{\s*req\./, text: 'Request data interpolated into SQL' },
  { id: 'js/command-injection', level: 'error', re: /exec(Sync)?\(\s*`[^`]*\$\{/, text: 'Shell command built from a template string' },
  { id: 'js/hardcoded-secret', level: 'error', re: /(secret|password|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9!@#$%^&*]{12,}['"]/i, text: 'Hard-coded credential' },
  { id: 'js/insecure-random', level: 'warning', re: /Math\.random\(\).*(token|session|secret)/i, text: 'Insecure randomness for a security value' },
];
// The team's scan configuration: findings it accepts by file, with the reason (SARIF external suppressions).
const SUPPRESS = [{ path: /^src\/db\/seed\.ts$/, justification: 'QE seed data: demo users and their demo password are never part of a production build' }];
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { if (['node_modules', 'dist', '.git', 'tests', 'test-results'].includes(n)) continue; const p = join(d, n); statSync(p).isDirectory() ? walk(p) : /\.(ts|js|mjs)$/.test(n) && files.push(p); } };
walk(join(dir, 'src'));
const results = [];
for (const f of files) readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
  for (const r of RULES) if (r.re.test(line)) {
    const uri = relative(dir, f), sup = SUPPRESS.find((x) => x.path.test(uri));
    results.push({ ruleId: r.id, level: r.level, message: { text: r.text },
      locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: i + 1 } } }],
      ...(sup ? { suppressions: [{ kind: 'external', justification: sup.justification }] } : {}) });
  }
});
writeFileSync(out, JSON.stringify({ $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [{
  tool: { driver: { name: 'prcheck-demo-sast', informationUri: 'https://prcheck.live', rules: RULES.map((r) => ({ id: r.id, shortDescription: { text: r.text }, defaultConfiguration: { level: r.level } })) } },
  versionControlProvenance: [{ repositoryUri: 'vendorpay/vendorpay-app', revisionId: sha }],
  results,
}] }, null, 2));
console.log(`SARIF: ${files.length} files scanned, ${results.length} results (${results.filter((r) => r.suppressions).length} suppressed)`);
