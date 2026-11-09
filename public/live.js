/* PRCheck.live live layer.
 *
 * ui/prototype.html is the approved product UI. Its screens are kept as they are;
 * this file replaces only its demo data and simulated actions:
 *   - sign-in goes to the engine (server-side password, verification code and roles)
 *   - every change, revision, obligation, evidence item and disposition comes from
 *     /api/ui/changes, i.e. from real assessments of real pull requests
 *   - "Re-run assurance" starts a real assessment; its stages stream from the engine
 *   - integrations, profiles and users show the platform's actual configuration
 * Actions the MVP engine does not perform yet are labelled as such, never faked.
 */
'use strict';

const LIVE = { access: null, members: null, memberApps: null, changes: [], byId: {}, rev: {}, caseRev: {}, platform: null, apps: null, appSel: null, users: null, sig: '', timer: null, deep: null, runPoll: null, wiz: null };

/* Repository names as people say them: "vendorpay-policies", not a URL or a path. */
const repoLabel = s => String(s || '').replace(/\.git$/, '').replace(/\/+$/, '').split(/[\/:]/).filter(Boolean).pop() || '';
const polName = ch => repoLabel(ch && ch.sources && ch.sources.policies) || 'policy repository';
const verName = ch => repoLabel(ch && ch.sources && ch.sources.verifiers) || 'verifiers';

/* ---------- API ---------- */
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, { method: opts.method || 'GET', credentials: 'same-origin',
      headers: opts.body ? { 'content-type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !opts.allow401 && $('.app') && !$('.app').hidden) { stopPolling(); showLogin({ t: 'info', m: 'Your session has ended. Sign in again.' }); }
    return { ok: res.ok, status: res.status, data };
  } catch (e) { return { ok: false, status: 0, data: { message: String(e) } }; }
}

/* ---------- Load and index live data ---------- */
async function loadLive() {
  if (access().scope === 'none') { LIVE.changes = []; LIVE.byId = {}; return true; }
  const r = await api('/api/ui/changes');
  if (!r.ok) return false;
  const sig = JSON.stringify(r.data.changes.map(c => c.assessments.map(a => [a.id, a.status, a.disposition, a.events.length])));
  const changed = sig !== LIVE.sig;
  LIVE.sig = sig; LIVE.changes = r.data.changes; LIVE.byId = {};
  for (const ch of LIVE.changes) {
    const jira = [...ch.assessments].reverse().find(a => a.jiraKey);
    ch.id = jira ? jira.jiraKey : `PR #${ch.prNumber}`;
    LIVE.byId[ch.id] = ch;
  }
  return changed;
}
const changeIds = () => LIVE.changes.filter(c => inScope(c.app)).map(c => c.id);
function revisionsOf(ch) {
  const order = [];
  for (const a of ch.assessments) if (!order.includes(a.headSha)) order.push(a.headSha);
  return order.map(sha => { const all = ch.assessments.filter(a => a.headSha === sha); return { sha, key: sha.slice(0, 7), all, latest: all[all.length - 1] }; });
}
const running = a => a && !['done', 'failed'].includes(a.status);
const anyRunning = () => LIVE.changes.some(c => c.assessments.some(running));

/* ---------- Map engine data onto the prototype's view model ---------- */
const SEV = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const STATE = s => (s === 'NOT_ASSESSED' ? 'NOT ASSESSED' : s);
const DCODE = { READY: 'READY', READY_WITH_EXCEPTIONS: 'READY_EXC', NOT_READY: 'NOT_READY', INDETERMINATE: 'INDETERMINATE', AWAITING_ASSESSMENT: 'NONE' };
const hex = d => String(d || '').replace(/^sha256:/, '');
const shortD = d => (d ? `sha256:${hex(d).slice(0, 4)}…${hex(d).slice(-4)}` : '—');
const STATUS_WORD = { queued: 'queued', gathering: 'gathering inputs', awaiting_environment: 'waiting for QE to run this commit', verifying: 'running verifiers', deciding: 'deciding', done: 'done', failed: 'failed' };

/** What a failed check observed, in words: its own message when it has one, otherwise expected and received. */
function observedText(reason) {
  const f = parseFailure(String(reason || '').replace(/^F-[^:]*:\s*/, ''));
  const msg = /^expect\(/.test(f.msg) ? '' : f.msg;
  if (f.received) return msg ? `Expected ${msg} (${f.expected}); observed ${f.received}` : `Expected ${f.expected}; observed ${f.received}`;
  return msg || f.msg || 'Not executed';
}
function parseFailure(reason) {
  const text = String(reason || '');
  const msg = (text.split('\n')[0] || '').replace(/^Error:\s*/, '').trim();
  const exp = /Expected:\s*(.+)/.exec(text), rec = /Received:\s*(.+)/.exec(text);
  return { msg, expected: exp ? exp[1].trim() : null, received: rec ? rec[1].trim() : null };
}
function traceRows(obs) {
  const rows = [];
  const val = v => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v).replace(/"/g, '').slice(0, 160) : String(v));
  if (Array.isArray(obs)) obs.slice(0, 10).forEach((x, i) => rows.push([`#${i + 1}`, val(x)]));
  else if (obs && typeof obs === 'object') Object.entries(obs).slice(0, 12).forEach(([k, v]) => rows.push([k, val(v)]));
  return rows;
}

function liveVM(ch, revKey) {
  const revs = revisionsOf(ch);
  const latestRev = revs[revs.length - 1];
  const cur = revs.find(r => r.key === revKey) || latestRev;
  const a = cur.latest, ctx = a.context || {}, pol = ctx.policy || { policies: [], components: {}, unmappedFiles: [], exceptions: [] };
  const env = ch.environment || { name: 'qe', baseUrl: '' };
  const envName = `${String(env.name).toUpperCase()} · ${env.baseUrl}`;
  const at = new Date(a.finishedAt || a.createdAt);
  const inProg = running(a);
  const envConfirmed = a.evidence ? a.evidence.environmentConfirmed : (ctx.environment ? ctx.environment.confirmed : null);
  const verCommit = a.evidence && a.evidence.verifierCommit;

  const policyOf = id => pol.policies.find(p => p.obligations.some(o => o.id === id));
  const history = id => ch.assessments.filter(x => x.status === 'done' || x.status === 'failed').map(x => {
    const r = x.obligations.find(o => o.obligation_id === id);
    return { run: { id: x.id, at: fmt(new Date(x.finishedAt || x.createdAt)) }, revKey: x.headSha.slice(0, 7), revHash: x.headSha.slice(0, 7), res: { state: r ? STATE(r.state) : 'NOT ASSESSED', exec: r ? execFor(x, r) : null } };
  });

  function execFor(x, r) {
    const chk = x.evidence && x.evidence.checks && x.evidence.checks[r.evidence_check];
    if (!chk) return null;
    const [vid, cname] = r.evidence_check.split('/');
    const cat = (ch.catalog || {})[vid] || {};
    const f = parseFailure(chk.reason);
    const observed = chk.state === 'SUPPORTED' ? 'Observed behaviour matched the expected behaviour'
      : chk.state === 'VIOLATED' ? (f.received ? `${f.msg}: received ${f.received}${f.expected ? `, expected ${f.expected}` : ''}` : f.msg)
      : (chk.reason || 'Not executed').split('\n')[0];
    return {
      verifier: { id: vid, name: `${vid} ${cat.name || ''}`.trim(), ver: x.evidence.verifierCommit ? `${verName(ch)}@${x.evidence.verifierCommit}` : '', label: `${(cat.name || vid).toLowerCase()} verifier` },
      env: envName, revHash: x.headSha.slice(0, 7), revKey: x.headSha.slice(0, 7), runId: x.id, at: fmt(new Date(x.finishedAt || x.createdAt)),
      expected: ((cat.checks || {})[cname] || `Behaviour consistent with ${r.policy_id}`).replace(/\.$/, ''),
      observed, result: STATE(chk.state),
      operational: chk.state === 'NOT_ASSESSED', error: chk.state === 'NOT_ASSESSED' ? chk.reason : null,
      finding: chk.state === 'VIOLATED' ? `Observed behaviour contradicts ${r.policy_id}` : chk.state === 'SUPPORTED' ? `Observed behaviour is consistent with ${r.policy_id}` : 'Evidence not obtained',
      digest: hex(x.digests.evidence),
      trace: [['Check', r.evidence_check], ...traceRows(chk.observation), ['QE commit', x.headSha.slice(0, 7)], ['Assessment', x.id], ['Evidence', shortD(x.digests.evidence)]],
      artifacts: [
        { name: 'evidence.json · verifier run', digest: shortD(x.digests.evidence), size: '' },
        { name: 'context.json · frozen inputs', digest: shortD(x.digests.context), size: '' },
        ...(x.digests.report ? [{ name: 'report.md · PR comment', digest: shortD(x.digests.report), size: '' }] : []),
      ],
    };
  }

  const obls = a.obligations.map(r => {
    const p = policyOf(r.obligation_id) || { id: r.policy_id, title: r.policy_id, owner: '', version: r.policy_version, file: '', digest: '' };
    const [vid] = r.evidence_check.split('/');
    const cat = (ch.catalog || {})[vid] || {};
    let state = STATE(r.state), gapType = null, gap = '—', plain = null, integrityFail = false;
    const exec = execFor(a, r);
    if (state === 'VIOLATED') { gapType = 'Violation'; const f = parseFailure(r.reason); gap = f.msg || 'Contradicting evidence'; plain = `${r.statement.replace(/\.$/, '')}: ${f.msg}${f.received ? ` (received ${f.received}, expected ${f.expected})` : ''}.`; }
    else if (state === 'INSUFFICIENT') { gapType = 'NoVerifier'; gap = 'No verifier evidence'; }
    else if (state === 'NOT ASSESSED') { gapType = envConfirmed === false ? 'Operational' : 'Pending'; gap = envConfirmed === false ? 'QE not running this commit' : /not yet approved/.test(r.reason || '') ? 'Verifier generated for this new rule is not yet approved' : 'Not yet evaluated'; }
    if (a.integrity.evidence === 'mismatch' && exec) { state = 'INSUFFICIENT'; gapType = 'Integrity'; gap = 'Evidence integrity mismatch'; integrityFail = true; }
    const exception = (pol.exceptions || []).find(x => x.policy === r.policy_id && (x.obligations || []).includes(r.obligation_id));
    return {
      id: r.obligation_id, title: r.statement.replace(/\.$/, ''), statement: r.statement, reason: r.reason, awaitingVerifier: r.state === 'NOT_ASSESSED' && /not yet approved/.test(r.reason || ''),
      authority: { cls: 'Authoritative', id: r.policy_id, name: p.title || r.policy_id, owner: p.owner || '', prov: `${polName(ch)} · ${p.file || r.policy_id} v${r.policy_version}${p.digest ? ' · ' + shortD(p.digest) : ''}` },
      crit: SEV[r.severity] || 'High', blocking: true, strength: ['SUPPORTED', 'VIOLATED'].includes(state) && !integrityFail ? 'Strong' : 'Missing',
      state, gap, gapType, plain, integrityFail, exec,
      verifier: { id: vid, name: `${vid} ${cat.name || ''}`.trim(), ver: verCommit ? `${verName(ch)}@${verCommit}` : '', label: `${(cat.name || vid).toLowerCase()} verifier` },
      proof: ((cat.checks || {})[r.evidence_check.split('/')[1]] || 'Independent behavioural evidence for this obligation').replace(/\.$/, '') + '.',
      assumptions: `QE (${env.baseUrl}) runs commit ${a.headSha.slice(0, 7)}, confirmed at /version before and after verification. Verifiers act through VendorPay's public API and UI with PRCheck.live's own test identities.`,
      noExec: inProg ? 'Assessment in progress.' : envConfirmed === false ? `Not executed. QE was not running ${a.headSha.slice(0, 7)}, so any evidence would be about a different build (PLT-001).` : 'No verifier evidence for this check.',
      exception: exception ? { id: exception.id, reason: exception.reason, owner: exception.approved_by, scope: `${exception.scope.repository} ${exception.scope.jira}`, control: exception.compensating_control, expiry: exception.expires } : null,
      history: history(r.obligation_id),
    };
  });

  const comps = Object.keys(pol.components || {});
  const unknownSrc = (pol.unmappedFiles || []).filter(f => /^(src|db|lib|app)\//.test(f));
  const risk = pol.policies.some(p => p.severity === 'critical') ? 'Critical' : pol.policies.some(p => p.severity === 'high') ? 'High' : 'Medium';
  const jira = ctx.jira;
  const vm = {
    id: ch.id, live: false, engine: true, change: ch, assessment: a,
    title: (jira && jira.summary) || a.title || `Pull request #${ch.prNumber}`, app: ch.app, producer: 'Developer via GitHub PR', risk,
    profile: pol.profile || '—', env: envName, exclusions: 'Performance, DR, production operations; anything outside the selected policies',
    intent: jira ? `${jira.summary}. ${jira.acceptanceCriteria.length} acceptance criteria in Jira ${jira.key} (${jira.status}).` : (a.title || 'No Jira issue linked.'),
    semantic: ctx.headCommit ? `${ctx.headCommit}. Changes ${ctx.files.length} files.` : `Changes ${(ctx.files || []).length} files.`,
    impacts: [['Observed', comps.length ? `Components touched: ${comps.join(', ')}` : 'No mapped components'], ['Derived', `${pol.policies.length} policies apply: ${pol.policies.map(p => p.id).join(', ')}`],
      ...(unknownSrc.length ? [['Unknown', `Source files not mapped to any component: ${unknownSrc.join(', ')}`]] : [])],
    scope: ctx.files || [],
    provenance: [['Pull request', `#${ch.prNumber} · ${ch.github}`], ['Branch', `${a.headRef || '—'} → ${a.baseRef}`], ['Work item', jira ? `${jira.key} · Jira · ${jira.status}` : 'None found'],
      ['Team tests', ctx.team ? `${ctx.team.passed}/${ctx.team.total} passed (Xray input)` : 'No results for this commit'], ['Triggered by', a.trigger.startsWith('github:') ? 'GitHub webhook' : a.trigger.replace('ui:', 'Re-run by ')]],
    riskRationale: `${risk} under the ${pol.profile} profile. The change touches ${comps.join(', ') || 'no mapped component'}, so ${pol.policies.filter(p => p.severity === 'critical').length} critical policies apply. PRCheck.live does not compute a risk score; materiality comes from the policies.`,
    business: null,
    rev: { key: cur.key, hash: cur.key, isLatest: cur.key === latestRev.key, latestHash: latestRev.key, latestKey: latestRev.key },
    revisions: revs.map(r => ({ key: r.key, hash: r.key, received: true })),
    run: inProg ? null : { id: a.id, at: fmt(at) }, assessed: !inProg && a.status === 'done', inProgress: inProg,
    cutoff: inProg ? '—' : fmt(at), obls, retired: [], updated: new Date(a.createdAt).getTime(),
  };
  finishVM(vm);
  // Functional lane: the story's acceptance criteria, as the engine judged them
  const fnChecks = (a.functional && a.functional.checks) || {};
  vm.lanes = a.lanes; vm.functional = a.functional;
  vm.imported = a.imported || [];
  if (vm.imported.some(x => x.format === 'k6-summary')) vm.exclusions = 'DR, production operations; anything outside the selected policies, stories and required tool results';
  // Regression lane: earlier stories re-verified on this build, grouped by story
  const rgRows = a.regression || [];
  vm.regression = [...new Set(rgRows.map(c => c.story))].map(st => ({ story: st, because: (rgRows.find(c => c.story === st) || {}).because || '',
    criteria: rgRows.filter(c => c.story === st).map(c => ({ ...c, ac: 'AC' + c.position, observed: c.state === 'SUPPORTED' ? 'Still met' : c.state === 'FAILED' ? observedText(c.reason) : (parseFailure(c.reason).msg || 'Not executed') })) }));
  vm.criteria = (a.criteria || []).map(c => ({
    ...c, ac: 'AC' + c.position,
    observed: c.state === 'SUPPORTED' ? 'Observed as promised' : c.state === 'FAILED' ? observedText(c.reason) : (parseFailure(c.reason).msg || 'Not executed'),
    obs: c.checks.map(k => ({ check: k, state: fnChecks[k] ? fnChecks[k].state : 'NOT_RUN', observation: fnChecks[k] ? fnChecks[k].observation : null })),
  }));
  // The engine's verdict is the verdict: the UI never re-decides it.
  const code = inProg ? 'NONE' : a.status === 'failed' ? 'INDETERMINATE' : (DCODE[a.disposition] || 'NONE');
  const violated = obls.filter(o => o.state === 'VIOLATED'), open = obls.filter(o => o.state !== 'SUPPORTED');
  const failedAc = vm.criteria.filter(c => c.state === 'FAILED'), story = vm.criteria.length ? vm.criteria[0].story : null;
  const acText = [...failedAc.map(c => `${c.ac} of ${c.story} is not met: ${c.observed.replace(/\.$/, '')}.`),
    ...vm.regression.flatMap(s => s.criteria.filter(c => c.state === 'FAILED').map(c => `This change breaks ${c.story} ${c.ac}, which already worked: ${c.observed.replace(/\.$/, '')}.`))].join(' ');
  const failedRg = vm.regression.flatMap(s => s.criteria.filter(c => c.state === 'FAILED'));
  const failedIm = vm.imported.filter(x => x.state === 'FAILED');
  const imText = failedIm.map(x => `${x.title} is outside its gate: ${x.reason}.`).join(' ');
  const reason = inProg ? `Assessment ${a.id} is ${STATUS_WORD[a.status] || a.status}.`
    : code === 'NOT_READY' && (violated.length || failedAc.length || failedRg.length || failedIm.length) ? 'Blocked: ' + [violated.map(plainViolation).join(' '), acText, imText].filter(Boolean).join(' ')
    : code === 'READY' ? `All ${obls.length} material obligations${vm.criteria.length ? `, all ${vm.criteria.length} acceptance criteria of ${story}` : ''}${vm.regression.length ? `, ${vm.regression.reduce((n, x) => n + x.criteria.length, 0)} criteria of ${vm.regression.length} earlier stories` : ''}${vm.imported.length ? ` and all ${vm.imported.length} required results from other tools` : ''} are supported by evidence bound to revision ${cur.key}. Nothing required is pending.`
    : (a.summary && a.summary.because) || a.error || DISP[code].desc;
  vm.disp = { code, reason, blockers: code === 'NOT_READY' ? violated : open };
  return vm;
}

/* ---------- Data functions the prototype calls ---------- */
function vmFor(id) { const ch = LIVE.byId[id]; return ch ? liveVM(ch, LIVE.rev[id]) : null; }
function curVM() { return vmFor(S.changeId); }
function allVMs() { return LIVE.changes.filter(c => inScope(c.app)).map(c => liveVM(c)); }

function ctxBar(vm) {
  const changeOpts = changeIds().map(id => `<option value="${esc(id)}"${id === vm.id ? ' selected' : ''}>${esc(id)}</option>`).join('');
  const revOpts = vm.revisions.map(r => `<option value="${r.key}"${r.key === vm.rev.key ? ' selected' : ''}>${r.hash}${vm.revisions.length > 1 ? (r.key === vm.rev.latestKey ? ' · current' : ' · previous') : ''}</option>`).join('');
  return `
    <span><span class="k">Change</span><select aria-label="Select change" data-change="ctx-change" title="${esc(vm.title)}">${changeOpts}</select></span>
    <span><span class="k">Application</span><span class="v">${esc(vm.app)}</span></span>
    <span><span class="k">Revision</span><select aria-label="Select revision" data-change="ctx-rev">${revOpts}</select></span>
    <span><span class="k">Profile</span><span class="v">${esc(vm.profile)}</span></span>
    <span class="grow"><span class="k">Disposition</span>${dispBadge(vm.disp.code, { action: 'why', title: 'Show the blocking obligation' })}</span>`;
}
function staleBanner(vm) {
  if (vm && vm.inProgress) return `<div class="notice info"><span><b>Assessment ${esc(vm.assessment.id)} in progress</b> · ${esc(STATUS_WORD[vm.assessment.status] || vm.assessment.status)}. This page updates by itself.</span></div>`;
  if (vm && !vm.rev.isLatest) return `<div class="notice amber"><span><b>Viewing previous revision ${vm.rev.hash}.</b> The current revision is ${vm.rev.latestHash}. Evidence shown here is bound to ${vm.rev.hash} only.</span><button class="btn" data-action="view-rev" data-id="${vm.rev.latestKey}">Switch to ${vm.rev.latestHash}</button></div>`;
  return '';
}
function runButton(vm) {
  if (!vm.rev.isLatest) return `<button class="btn" disabled title="Assurance runs on the current revision">Run assurance</button>`;
  if (vm.inProgress || (S.running && !S.running.done)) return `<button class="btn" disabled>Assessment running…</button>`;
  const asked = openReqs(vm.change).find(r => r.kind === 'rerun' && r.headSha.startsWith(vm.rev.hash));
  if (!can('run') && ME.sysRole === 'Contributor') return asked
    ? `<button class="btn" disabled title="Waiting for the Assurance Lead">Re-run requested${asked.by.email === ME.email ? ' by you' : ` by ${esc(asked.by.name)}`}</button>`
    : `<button class="btn" data-action="request-rerun">Request re-run</button>`;
  return gate(can('run'), `<button class="btn primary" data-action="run">Re-run assurance${asked ? ` <span style="font-weight:500;opacity:.85">· requested by ${esc(asked.by.name)}</span>` : ''}</button>`, NEEDS.run);
}

function emptyChanges() {
  return `<div class="card" style="max-width:680px;margin:40px auto;text-align:center;padding:36px 32px"><h1 style="font-size:22px;margin:0 0 8px;color:var(--navy)">No pull requests assessed yet</h1>
    <p class="muted" style="margin:0">PRCheck.live starts an assessment when a pull request is opened or updated on an onboarded repository${access().scope !== 'all' ? ` in ${esc([].concat(access().scope).join(', '))}` : ''}. It appears here within seconds.</p></div>`;
}
function render() {
  const r = route(), navR = NAV_FOR[r] || r;
  const ids = changeIds();
  if (CHANGE_ROUTES.includes(r) && !ids.includes(S.changeId) && ids.length) S.changeId = ids[0];
  if (!allowed(r)) {
    document.querySelectorAll('#nav a, #util a').forEach(a => { a.classList.remove('on'); a.removeAttribute('aria-current'); });
    $('#ctx').hidden = true; $('#ctx').innerHTML = ''; $('#view').innerHTML = viewDenied(r); return;
  }
  document.querySelectorAll('#nav a, #util a').forEach(a => { const on = a.dataset.r === navR; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const ctx = $('#ctx'), v = $('#view');
  if (CHANGE_ROUTES.includes(r) && r !== 'command' && !ids.length) { ctx.hidden = true; ctx.innerHTML = ''; v.innerHTML = emptyChanges(); return; }
  if (CHANGE_ROUTES.includes(r) && r !== 'command') { ctx.hidden = false; ctx.innerHTML = ctxBar(curVM()); } else if (CHANGE_ROUTES.includes(r)) { ctx.hidden = true; ctx.innerHTML = ''; } else { ctx.hidden = true; ctx.innerHTML = ''; }
  const fn = { home: viewHome, command: viewCommand, change: viewChange, revisions: viewRevisions, graph: viewGraph, obligations: viewObligations, gaps: viewGaps, evidence: viewEvidence, case: viewCase, integrations: viewIntegrations, onboard: viewOnboard, suites: viewSuites, profiles: viewProfiles, 'org-settings': viewSettings }[r];
  let html = fn();
  if (r === 'obligations') { const any = curVM().obls[0]; if (any) html = html.replace('>AUTH-009<', `>${esc(any.authority.id)}<`); }
  v.innerHTML = html;
}
function flowUpdate() { const f = $('#flow-root'); if (f) f.innerHTML = ''; }

/* ---------- Revisions ---------- */
function viewRevisions() {
  const vm = curVM(), ch = vm.change, revs = revisionsOf(ch);
  const list = revs.slice().reverse().map(r => ({ key: r.key, hash: r.key, submitted: fmt(new Date(r.all[0].createdAt)),
    summary: (r.latest.context && r.latest.context.headCommit) || r.latest.title || '', runs: r.all.map(x => ({ id: x.id })), disp: liveVM(ch, r.key).disp,
    cur: r.key === vm.rev.latestKey, viewing: r.key === vm.rev.key }));
  let compare = '';
  if (revs.length > 1) {
    const vms = revs.map(r => liveVM(ch, r.key));
    const ids = [...new Set(vms.flatMap(x => x.obls.map(o => o.id)))].sort();
    const rows = ids.map(id => {
      const cells = vms.map(x => x.obls.find(o => o.id === id));
      const first = cells.find(Boolean);
      const [p, q] = [cells[cells.length - 2], cells[cells.length - 1]];
      let delta = 'Unchanged';
      if (p && q && p.state !== 'SUPPORTED' && q.state === 'SUPPORTED') delta = 'Now supported';
      else if (p && q && p.state === 'SUPPORTED' && q.state !== 'SUPPORTED') delta = 'Regressed';
      else if (p && q && p.state !== q.state) delta = 'Changed';
      const tone = delta === 'Now supported' ? 't-green' : delta === 'Regressed' ? 't-red' : delta === 'Unchanged' ? 't-neutral' : 't-amber';
      return `<tr><td><span class="oid">${esc(id)}</span><span class="otitle">${esc(first.title)}</span></td>${cells.map(c => `<td>${c ? stateBadge(c.state) : '<span class="muted small">not selected</span>'}</td>`).join('')}<td><span class="badge ${tone}">${delta}</span></td></tr>`;
    }).join('');
    compare = `<div class="card" style="margin-top:20px;padding:0"><div style="padding:18px 22px 6px"><h2 style="margin:0">Compare revisions</h2><p class="small muted" style="margin:4px 0 10px">Each obligation's state on every revision of ${esc(vm.id)}. The last column compares the two newest.</p></div>
      <div class="tbl-wrap" style="border:0;border-top:1px solid var(--line);border-radius:0 0 12px 12px"><table><thead><tr><th>Obligation</th>${vms.map(x => `<th><span class="mono">${x.rev.hash}</span> · ${DISP[x.disp.code].label}</th>`).join('')}<th>Change</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }
  const events = ch.assessments.flatMap(x => x.events.map(e => ({ ...e, a: x.id, sha: x.headSha.slice(0, 7) }))).sort((x, y) => new Date(y.at) - new Date(x.at)).slice(0, 40);
  return `${staleBanner(vm)}
    <div class="ph"><div><h1>${esc(vm.id)}<span class="sep">·</span>Revisions</h1><p class="sub">Every push to PR #${ch.prNumber} is a revision with its own evidence and disposition. History is preserved, not replaced.</p></div><div class="acts">${runButton(vm)}</div></div>
    <div style="margin-bottom:18px">${changeTabs('revisions')}</div>
    ${revTable(list)}
    ${compare}
    <div class="card" style="margin-top:20px"><h2>Activity</h2><div class="tl">${events.map(e => `<div class="e"><div class="w">${esc(fmt(new Date(e.at)))}</div><div><b>${esc(e.a)}</b> <span class="mono small muted">${esc(e.sha)}</span> · <b>${esc(e.step)}</b> · ${esc(e.message)}</div></div>`).join('')}</div></div>`;
}

/* ---------- Gaps (real actions only) ---------- */
/* ---------- Contributor requests: re-run, acknowledge, dispute ---------- */
const REQ_WORD = { rerun: 'Re-run requested', acknowledge: 'Acknowledged', dispute: 'Disputed' };
/** open, or what became of it: done (Lead re-ran), upheld / check_changed (dispute answered), superseded (a newer commit), fixed (supported on a newer commit) */
function reqState(ch, r) {
  if (r.status !== 'open') return r.status;
  const revs = revisionsOf(ch), latest = revs[revs.length - 1];
  if (!latest || latest.sha === r.headSha) return 'open';
  if (r.kind === 'rerun') return 'superseded';
  const now = (latest.latest.obligations || []).find(x => x.obligation_id === r.obligationId) || (latest.latest.criteria || []).find(x => x.id === r.obligationId);
  return now && now.state === 'SUPPORTED' ? 'fixed' : 'superseded';
}
const openReqs = ch => ((ch && ch.requests) || []).filter(r => reqState(ch, r) === 'open');
const REQ_STATE = { open: ['Open', 's-Requires'], done: ['Done', 's-Connected'], upheld: ['Finding stands', 's-Error'], check_changed: ['Check will be corrected', 's-Connected'], superseded: ['Superseded by a newer commit', 's-Available'], fixed: ['Fixed in a newer commit', 's-Connected'] };
function reqList(list, ch) {
  if (!list.length) return '';
  return `<div class="reqs" style="margin:10px 0 12px;display:flex;flex-direction:column;gap:6px">${list.map(r => { const [w, cls] = REQ_STATE[reqState(ch, r)];
    return `<div class="small" style="border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--surface-2)"><b>${REQ_WORD[r.kind]}</b> by ${esc(r.by.name)} · ${esc(ago(r.at))} · <span class="${cls}">${w}</span>
      ${r.note ? `<div style="margin-top:3px">${esc(r.note)}</div>` : ''}${r.eta ? `<div class="muted">Fix expected ${esc(r.eta)}</div>` : ''}
      ${r.resolved ? `<div class="muted" style="margin-top:3px">${esc(r.resolved.name)} · ${esc(ago(r.resolved.at))}${r.resolved.note ? ': ' + esc(r.resolved.note) : ''}</div>` : ''}</div>`; }).join('')}</div>`;
}
function reqDrawer(kind, id) {
  const vm = curVM(), today = new Date().toISOString().slice(0, 10);
  const note = (label, ph, req) => `<div class="field"><label for="rq-note">${label}${req ? '' : ' <span class="muted">(optional)</span>'}</label><textarea id="rq-note" placeholder="${ph}"></textarea><span class="err" id="rq-err"></span></div>`;
  const head = `<p class="small muted" style="margin:0">${kind === 'rerun' ? `Revision <span class="mono">${esc(vm.rev.hash)}</span>` : `<b>${esc(id)}</b> on revision <span class="mono">${esc(vm.rev.hash)}</span>`} · ${esc(vm.id)}</p>`;
  if (kind === 'rerun') return ['Request a re-run', head + note('Why should it run again?', 'For example: QE was down during the last run', false)
    + '<p class="small muted" style="margin:0">The Assurance Lead sees this on their queue. It is closed when they re-run this revision, or when you push a new commit.</p><div class="btnrow"><button class="btn primary" data-action="req-send" data-id="rerun">Send request</button></div>'];
  if (kind === 'ack') return ['Acknowledge finding', head + note('What is being done about it?', 'For example: fix in progress, holds scheduled payments on approval', true)
    + `<div class="field"><label for="rq-eta">Fix expected <span class="muted">(optional)</span></label><input id="rq-eta" type="date" min="${today}"></div>
      <p class="small muted" style="margin:0">This does not change the verdict. It tells the Assurance Lead and the rule owner the finding is being handled.</p><div class="btnrow"><button class="btn primary" data-action="req-send" data-id="ack:${esc(id)}">Acknowledge</button></div>`];
  if (kind === 'dispute') return ['Dispute the check', head + note('Why do you think the check is wrong?', 'What the check expects, and why the application is right', true)
    + '<p class="small muted" style="margin:0">The verdict stands while the Assurance Lead reviews the verifier. If the check is wrong, it is corrected in the verifiers repository and the change is assessed again.</p><div class="btnrow"><button class="btn primary" data-action="req-send" data-id="dispute:' + esc(id) + '">Send dispute</button></div>'];
  const r = (vm.change.requests || []).find(x => String(x.id) === String(id));
  return ['Resolve dispute', `<p class="small muted" style="margin:0"><b>${esc(r.obligationId)}</b> · disputed by ${esc(r.by.name)}</p><div class="trace" style="margin:0"><div class="rows" style="display:block;white-space:pre-wrap">${esc(r.note)}</div></div>
    <fieldset class="field" style="border:0;padding:0;margin:0"><legend style="font-size:12.5px;font-weight:600;margin-bottom:6px">Decision</legend>
      <label class="small" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px"><input type="radio" name="rq-out" value="upheld" checked> <span><b>The finding stands.</b> The check is right; the change must be fixed.</span></label>
      <label class="small" style="display:flex;gap:8px;align-items:flex-start"><input type="radio" name="rq-out" value="check_changed"> <span><b>The check will be corrected</b> in the verifiers repository, by pull request. Re-run after it merges.</span></label></fieldset>
    ${note('Explain the decision', 'What you checked and why', true)}<div class="btnrow"><button class="btn primary" data-action="req-send" data-id="resolve:${r.id}">Save decision</button></div>`];
}
async function reqSend(what) {
  const vm = curVM(), a = vm.assessment, val = sel => { const el = $(sel); return el ? el.value.trim() : ''; };
  const [kind, arg] = what.split(':');
  const note = val('#rq-note'), err = m => { const e = $('#rq-err'); if (e) e.textContent = m; };
  let r;
  if (kind === 'rerun') r = await api(`/api/ui/assessments/${encodeURIComponent(a.id)}/request-rerun`, { method: 'POST', body: { note } });
  else if (kind === 'ack') { if (!note) return err('Say what is being done about it.'); r = await api(`/api/ui/assessments/${encodeURIComponent(a.id)}/findings/${encodeURIComponent(arg)}/acknowledge`, { method: 'POST', body: { note, eta: val('#rq-eta') } }); }
  else if (kind === 'dispute') { if (note.length < 15) return err('Explain why the check is wrong (at least 15 characters).'); r = await api(`/api/ui/assessments/${encodeURIComponent(a.id)}/findings/${encodeURIComponent(arg)}/dispute`, { method: 'POST', body: { reason: note } }); }
  else { if (note.length < 5) return err('Explain the decision.'); const out = (document.querySelector('input[name="rq-out"]:checked') || {}).value; r = await api(`/api/ui/requests/${encodeURIComponent(arg)}/resolve`, { method: 'POST', body: { outcome: out, note } }); }
  if (!r.ok) return err(r.data.message || `Not saved (HTTP ${r.status}).`);
  $('#drawer-root').innerHTML = '';
  toast({ rerun: 'Re-run requested. The Assurance Lead sees it on their queue.', ack: 'Acknowledged. The Assurance Lead and the rule owner can see it.', dispute: 'Dispute sent. The verdict stands while the Assurance Lead reviews the check.', resolve: 'Decision saved and recorded in the change activity.' }[kind]);
  await refresh(true);
}

/* ---------- Lanes and acceptance criteria (functional lane) ---------- */
function lanesPanel(vm) {
  const L = vm.lanes;
  if (!L) return '';
  const req = L.required || ['policy'];
  const row = (name, tone, result, note, required) => `<div style="display:grid;grid-template-columns:150px minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--line)">
      <b>${name}</b><span class="small">${result}${note ? `<span class="muted"> · ${note}</span>` : ''}</span>
      <span>${tone === 'ok' ? '<span class="badge t-green">COMPLETE</span>' : tone === 'bad' ? '<span class="badge t-red">BLOCKING</span>' : tone === 'wait' ? '<span class="badge t-amber">PENDING</span>' : `<span class="badge t-neutral">${required ? 'REQUIRED' : 'PLANNED'}</span>`}</span></div>`;
  const p = L.policy, f = L.functional;
  const pTone = p.disposition === 'NOT_READY' ? 'bad' : ['READY', 'READY_WITH_EXCEPTIONS'].includes(p.disposition) ? 'ok' : 'wait';
  const fTone = !f ? 'none' : f.failed ? 'bad' : f.ran && !f.pending ? 'ok' : 'wait';
  return `<div class="card" style="margin-bottom:20px"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h2 style="margin:0">Release lanes</h2>
      <span class="small muted">Required by the ${esc(vm.profile)} profile: ${req.map(esc).join(', ')}</span></div>
    <div style="margin-top:8px">
      ${row('Policy', pTone, `${p.supported}/${p.obligations} obligations supported`, 'frozen verifiers', true)}
      ${f ? row('Functional', fTone, f.ran ? `${f.supported}/${f.criteria} acceptance criteria of ${esc(f.story)} supported${f.failed ? `, ${f.failed} failed` : ''}${f.pending ? `, ${f.pending} not yet verified` : ''}` : esc(f.because), 'approved agent-generated checks', f.required) : row('Functional', 'none', 'Not required by this profile', '', false)}
      ${(r => !r ? row('Regression', 'none', 'Not required by this profile', '', false) : row('Regression', !r.ran ? 'none' : r.failed ? 'bad' : r.pending ? 'wait' : 'ok',
        r.ran ? (r.stories.length ? `${r.supported}/${r.criteria} criteria of ${r.stories.map(x => esc(x.story)).join(', ')} still met${r.failed ? `, ${r.failed} broken` : ''}${r.pending ? `, ${r.pending} not yet verified` : ''}` : esc(r.because)) : esc(r.because),
        r.confidence === 'unknown-impact' ? 'impact unknown: full regression' : 'selected by change impact', r.required))(L.regression)}
      ${(r => !r ? row('Imported evidence', 'none', 'Not required by this profile', '', false) : row('Imported evidence', !r.ran ? 'none' : r.failed ? 'bad' : r.pending ? 'wait' : 'ok',
        r.ran && r.total ? `${r.supported}/${r.total} required results within their gates${r.failed ? `, ${r.failed} outside` : ''}${r.pending ? `, ${r.pending} not received` : ''}` : esc(r.because), 'security, dependencies, performance', r.required))(L.imported)}
    </div>
    <p class="small" style="margin:10px 0 0">${L.pending && L.pending.length ? `<b style="color:var(--amber-text)">Pending, so this cannot be READY:</b> ${esc(L.pending.join('; '))}.` : vm.disp.code === 'READY' || vm.disp.code === 'READY_EXC' ? '<b style="color:var(--green-text)">Nothing pending.</b> Every lane the profile requires is complete for this revision.' : 'A blocking lane decides this revision. Nothing pending is checked once nothing blocks.'}</p></div>`;
}
function criteriaPanel(vm) {
  if (!vm.criteria.length) {
    const f = vm.lanes && vm.lanes.functional;
    return f && f.required ? `<div class="card" style="margin-bottom:20px"><h2>Story promises</h2><p class="muted" style="margin:0">${esc(f.because)}.</p></div>` : '';
  }
  const fn = vm.functional, s = fn && fn.suite;
  return `<div class="card" style="margin-bottom:20px"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h2 style="margin:0">Story promises · ${esc(vm.criteria[0].story)}</h2>
      <span class="small muted">${s ? `Suite approved by ${esc(s.approvedBy || '—')}${s.approvedAt ? ' on ' + esc(s.approvedAt) : ''} · ${esc(fn.core.name)} ${esc(fn.core.version)}` : 'No approved suite'}</span></div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:12px">${vm.criteria.map(c => `<div style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start">
      <div>${critBadge(c.state)}</div>
      <div><span class="oid">${esc(c.ac)}</span><b>${esc(c.text)}</b>
        <div class="small ${c.state === 'FAILED' ? '' : 'muted'}" style="${c.state === 'FAILED' ? 'color:var(--red-text)' : ''}">${esc(c.state === 'SUPPORTED' ? 'Observed as promised on ' + vm.rev.hash : c.observed)}</div>
        <div class="small muted mono" style="margin-top:2px">${c.checks.map(esc).join(' · ') || 'no checks'} · ${esc(SUITE_WORD[c.suiteStatus] || c.suiteStatus)}</div></div></div>`).join('')}</div>
    <p class="small muted" style="margin:12px 0 0">Checks are designed and generated by the agent core, proven on a correct and a broken build, and approved by an Assurance Lead before they count. The team's own tests never make a criterion supported.</p></div>`;
}
function regressionPanel(vm) {
  if (!vm.regression || !vm.lanes || !vm.lanes.regression) return '';
  const r = vm.lanes.regression;
  if (!vm.regression.length) return r.ran ? `<div class="card" style="margin-bottom:20px"><h2>Earlier stories</h2><p class="muted" style="margin:0">${esc(r.because)}.</p></div>` : '';
  return `<div class="card" style="margin-bottom:20px"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h2 style="margin:0">Earlier stories re-verified</h2>
      <span class="small muted">${r.confidence === 'unknown-impact' ? 'Impact unknown: every earlier story' : 'Selected by change impact'} · approved suites</span></div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:12px">${vm.regression.map(st => { const bad = st.criteria.filter(c => c.state !== 'SUPPORTED');
      return `<div><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b>${esc(st.story)}</b>${bad.some(c => c.state === 'FAILED') ? '<span class="badge t-red">BROKEN</span>' : bad.length ? '<span class="badge t-amber">PENDING</span>' : '<span class="badge t-green">STILL MET</span>'}<span class="small muted">${st.criteria.length - bad.length}/${st.criteria.length} criteria · ${esc(st.because)}</span></div>
        ${bad.map(c => `<div style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;margin:8px 0 0 14px">${critBadge(c.state)}<div><span class="oid">${esc(c.ac)}</span>${esc(c.text)}<div class="small" style="${c.state === 'FAILED' ? 'color:var(--red-text)' : ''}">${esc(c.observed)}</div></div></div>`).join('')}</div>`; }).join('')}</div>
    <p class="small muted" style="margin:12px 0 0">Each earlier story's approved suite runs on this exact build when the change touches a component the story lives in. A changed file that maps to no component re-verifies every earlier story.</p></div>`;
}
const IM_BADGE = { SUPPORTED: '<span class="badge t-green">WITHIN GATE</span>', FAILED: '<span class="badge t-red">OUTSIDE GATE</span>', NOT_ASSESSED: '<span class="badge t-amber">NOT RECEIVED</span>' };
const gateText = g => Object.entries(g || {}).map(([k, v]) => k === 'p95_ms' ? `p95 ≤ ${v} ms` : k === 'error_rate' ? `errors ≤ ${(v * 100).toFixed(1)}%` : `${k} ≤ ${v}`).join(', ');
function importedPanel(vm) {
  if (!vm.imported || !vm.imported.length) return '';
  return `<div class="card" style="margin-bottom:20px"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h2 style="margin:0">Results from other tools</h2>
      <span class="small muted">Required by the profile · produced by the team's CI for this commit · sealed</span></div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:12px">${vm.imported.map(x => `<div style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start">
      <div>${IM_BADGE[x.state] || ''}</div>
      <div><b>${esc(x.title)}</b> <span class="small muted">${esc(x.format)} · owner ${esc(x.owner || '—')} · gate ${esc(gateText(x.gate))}</span>
        <div class="small" style="${x.state === 'FAILED' ? 'color:var(--red-text)' : ''}">${esc(x.state === 'SUPPORTED' ? x.summary : x.reason || x.summary)}</div>
        ${(x.findings || []).slice(0, 4).map(f => `<div class="small ${f.suppressed ? 'muted' : ''}" style="margin-top:2px"><span class="mono">${esc(f.level)}</span> ${esc(f.text)}${f.where ? ` <span class="mono muted">${esc(f.where)}</span>` : ''}${f.suppressed ? ` · suppressed: ${esc(f.suppressed)}` : ''}</div>`).join('')}
        ${x.digest ? `<div class="small muted mono" style="margin-top:2px">${esc(shortD(x.digest))}</div>` : ''}</div></div>`).join('')}</div>
    <p class="small muted" style="margin:12px 0 0">A result about another commit or build, or one that never arrived, is pending, never a pass. Suppressed findings are shown with their reason and do not count against the gate.</p></div>`;
}
function imGapCards(vm) {
  return (vm.imported || []).filter(x => x.state !== 'SUPPORTED').map(x => {
    const failed = x.state === 'FAILED';
    return `<article class="gap blocking${failed ? '' : ' amberish'}">
      <div class="t">${IM_BADGE[x.state]}<div class="small muted" style="margin-top:6px">Imported evidence</div></div>
      <div class="b"><h3>${esc(x.title)}</h3>
        <div class="small muted">Blocking · required by the profile · owner ${esc(x.owner || '—')} · gate ${esc(gateText(x.gate))}</div>
        <dl><dt>${failed ? 'Measured' : 'Cause'}</dt><dd>${failed ? `<span class="obs-red">${esc(x.reason)}</span><br>${esc(x.summary)}` : esc(x.reason || 'Not received')}</dd>
          ${(x.findings || []).filter(f => !f.suppressed).length ? `<dt>Findings</dt><dd class="small">${x.findings.filter(f => !f.suppressed).slice(0, 5).map(f => `${esc(f.level)}: ${esc(f.text)}${f.where ? ` <span class="mono muted">${esc(f.where)}</span>` : ''}`).join('<br>')}</dd>` : ''}
          <dt>Release consequence</dt><dd>${failed ? 'NOT READY until a new commit brings it within the gate.' : 'INDETERMINATE: every required result must arrive for this commit. Nothing may be pending.'}</dd></dl>
        <div class="resolve"><b>What would resolve this?</b> ${failed ? 'Fix the cause (for example upgrade the dependency, or remove the slow path) and push; the team\'s CI produces the result for the new commit.' : `The team's CI must publish the ${esc(x.title.toLowerCase())} for ${esc(vm.rev.hash)}; then re-run assurance.`}</div>
        <div class="btnrow">${!failed && vm.rev.isLatest ? gate(can('run'), `<button class="btn primary" data-action="run">Re-run assurance on ${vm.rev.hash}</button>`, NEEDS.run) : ''}</div></div></article>`;
  }).join('');
}
function regGapCards(vm) {
  return (vm.regression || []).flatMap(st => st.criteria.filter(c => c.state !== 'SUPPORTED').map(c => {
    const failed = c.state === 'FAILED', mine = (vm.change.requests || []).filter(r => r.obligationId === c.id && r.headSha.startsWith(vm.rev.hash));
    const ack = mine.find(r => r.kind === 'acknowledge' && r.status === 'open'), dis = mine.find(r => r.kind === 'dispute' && r.status === 'open');
    let actions = failed ? `<span class="small muted">Posted to PR #${vm.change.prNumber} by <span class="mono">prcheck/assurance</span> and <span class="mono">prcheck/regression</span>.</span>`
      : can('run') ? '<button class="btn primary" data-action="gen-go">Review generated checks</button>' : '<span class="small muted">Waiting for the Assurance Lead.</span>';
    if (vm.rev.isLatest && failed) {
      if (ME.sysRole === 'Contributor') { actions += `<button class="btn" data-action="req-ack" data-id="${esc(c.id)}">${ack ? 'Update acknowledgement…' : 'Acknowledge…'}</button>`; if (!dis) actions += `<button class="btn" data-action="req-dispute" data-id="${esc(c.id)}">Dispute the check…</button>`; }
      if (dis && can('run')) actions += `<button class="btn primary" data-action="req-resolve" data-id="${dis.id}">Resolve dispute…</button>`;
    }
    return `<article class="gap blocking${failed ? '' : ' amberish'}">
      <div class="t"><span class="badge ${failed ? 't-red' : 't-amber'}">${failed ? 'REGRESSION' : 'NOT VERIFIED'}</span><div class="small muted" style="margin-top:6px">Regression lane</div></div>
      <div class="b"><h3><span class="oid">${esc(c.story)} ${esc(c.ac)}</span>${esc(c.text)}</h3>
        <div class="small muted">Blocking · Earlier story · re-verified because ${esc(st.because)}</div>
        <dl><dt>${failed ? 'Observed' : 'Cause'}</dt><dd>${failed ? `<span class="obs-red">${esc(c.observed)}</span>` : esc(c.reason || 'Not verified')}</dd>
          <dt>Checks</dt><dd class="mono small">${(c.checks || []).map(esc).join('<br>')}</dd>
          <dt>Release consequence</dt><dd>${failed ? `NOT READY: this change breaks ${esc(c.story)}, which already worked.` : 'INDETERMINATE: every selected earlier story must be re-verified. Nothing may be pending.'}</dd></dl>
        <div class="resolve"><b>What would resolve this?</b> ${failed ? `Restore the earlier behaviour (or change ${esc(c.story)} on purpose, through its own story) and push.` : 'Approve current checks for the earlier story, then re-run.'}</div>
        ${reqList(mine, vm.change)}
        <div class="btnrow">${actions}</div></div></article>`;
  })).join('');
}
function caseHeadline(vm) {
  const imOut = (vm.imported || []).filter(x => x.state === 'FAILED');
  if (vm.disp.code === 'NOT_READY' && imOut.length && !vm.obls.some(o => o.state === 'VIOLATED') && !(vm.criteria || []).some(c => c.state === 'FAILED') && !(vm.regression || []).some(st => st.criteria.some(c => c.state === 'FAILED')))
    return `${imOut.map(x => x.title).join(' and ')} ${imOut.length > 1 ? 'are' : 'is'} outside ${imOut.length > 1 ? 'their gates' : 'its gate'}.`;
  const rgBroken = (vm.regression || []).flatMap(st => st.criteria.filter(c => c.state === 'FAILED'));
  if (vm.disp.code === 'NOT_READY' && rgBroken.length && !vm.obls.some(o => o.state === 'VIOLATED') && !(vm.criteria || []).some(c => c.state === 'FAILED'))
    return `The change breaks ${[...new Set(rgBroken.map(c => c.story))].join(', ')}, which already worked.`;
  return caseHeadlineLanes(vm);
}
function caseHeadlineLanes(vm) {
  const d = vm.disp.code, crit = vm.criteria || [], failed = crit.filter(c => c.state === 'FAILED');
  if (d === 'NONE') return `Revision ${vm.rev.hash} has not been assessed yet.`;
  const rgN = (vm.regression || []).reduce((n, x) => n + x.criteria.length, 0);
  const imN = (vm.imported || []).length;
  if (d === 'READY') return `All ${vm.obls.length} obligations${crit.length ? `, ${crit.length} acceptance criteria` : ''}${rgN ? `, ${rgN} earlier-story criteria` : ''}${imN ? ` and ${imN} tool results` : ''} are supported. Nothing is pending.`;
  if (d === 'READY_EXC') return `Ready with ${vm.obls.filter(o => o.exception).length} accepted exception. Nothing else is pending.`;
  if (d === 'INDETERMINATE') return vm.lanes && vm.lanes.pending && vm.lanes.pending.length ? 'Not decidable yet: required evidence is pending.' : 'Not decidable: PRCheck.live could not prove what it tested.';
  const v = vm.obls.filter(o => o.state === 'VIOLATED').length;
  return [v ? `${v} obligation${v > 1 ? 's are' : ' is'} violated` : '', failed.length ? `${failed.map(c => c.ac).join(', ')} of the story ${failed.length > 1 ? 'are' : 'is'} not met` : ''].filter(Boolean).join(' and ') + '.';
}
function critGapCards(vm) {
  return vm.criteria.filter(c => c.state !== 'SUPPORTED').map(c => {
    const mine = (vm.change.requests || []).filter(r => r.obligationId === c.id && r.headSha.startsWith(vm.rev.hash));
    const ack = mine.find(r => r.kind === 'acknowledge' && r.status === 'open'), dis = mine.find(r => r.kind === 'dispute' && r.status === 'open');
    let actions = '';
    if (c.state === 'FAILED') actions += `<span class="small muted">Posted to PR #${vm.change.prNumber} by <span class="mono">prcheck/assurance</span> and <span class="mono">prcheck/functional</span>. The producer fixes it and pushes a new revision.</span>`;
    else if (vm.rev.isLatest) actions += c.suiteStatus === 'approved' ? gate(can('run'), `<button class="btn primary" data-action="run">Re-run assurance on ${vm.rev.hash}</button>`, NEEDS.run)
      : can('run') ? `<button class="btn primary" data-action="gen-go">Review generated checks</button><span class="small muted">Until they are approved the change cannot be READY.</span>` : '<span class="small muted">Waiting for the Assurance Lead to approve checks for this criterion.</span>';
    if (vm.rev.isLatest && c.state === 'FAILED') {
      if (ME.sysRole === 'Contributor') {
        actions += `<button class="btn" data-action="req-ack" data-id="${esc(c.id)}">${ack ? 'Update acknowledgement…' : 'Acknowledge…'}</button>`;
        actions += dis ? '' : `<button class="btn" data-action="req-dispute" data-id="${esc(c.id)}">Dispute the check…</button>`;
      }
      if (dis && can('run')) actions += `<button class="btn primary" data-action="req-resolve" data-id="${dis.id}">Resolve dispute…</button>`;
    }
    const failed = c.state === 'FAILED';
    return `<article class="gap${failed ? ' blocking' : ' blocking amberish'}">
      <div class="t"><span class="badge ${failed ? 't-red' : 't-amber'}">${failed ? 'PROMISE NOT MET' : 'NOT VERIFIED'}</span><div class="small muted" style="margin-top:6px">Functional lane</div></div>
      <div class="b"><h3><span class="oid">${esc(c.ac)}</span>${esc(c.text)}</h3>
        <div class="small muted">Blocking · Acceptance criterion of ${esc(c.story)} · checks ${esc(SUITE_WORD[c.suiteStatus] || c.suiteStatus)}</div>
        <dl><dt>${failed ? 'Observed' : 'Cause'}</dt><dd>${failed ? `<span class="obs-red">${esc(c.observed)}</span>` : esc(c.reason || 'Not verified')}</dd>
          <dt>Checks</dt><dd class="mono small">${c.checks.map(esc).join('<br>') || '—'}</dd>
          <dt>Release consequence</dt><dd>${failed ? 'NOT READY: the story does not do what it promises.' : 'INDETERMINATE: READY needs every acceptance criterion verified. Nothing may be pending.'}</dd></dl>
        <div class="resolve"><b>What would resolve this?</b> ${failed ? 'Fix the behaviour and push; PRCheck.live re-verifies the new revision automatically.' : c.suiteStatus === 'stale' ? 'The agent core regenerates checks for the changed criterion; an Assurance Lead approves them.' : 'An Assurance Lead approves proven checks for this criterion, then assurance runs again.'}</div>
        ${reqList(mine, vm.change)}
        <div class="btnrow">${actions}</div></div></article>`;
  }).join('');
}


/* ---------- Generated checks: trust graduation (Assurance Lead). GEN_* and SUITE_WORD come from the prototype. ---------- */
async function loadGen(force) {
  if (LIVE.gen && !force) return LIVE.gen;
  const r = await api('/api/ui/suites');
  LIVE.gen = r.ok ? r.data : { applications: [], reviews: [], error: r.data.message || `HTTP ${r.status}` };
  return LIVE.gen;
}
/** Every reviewable item: verifiers for new rules and functional checks per criterion. */
function genItems(G) {
  const out = [];
  for (const a of G.applications) {
    const ms = a.missions || [];
    const missionFor = (pred) => ms.find(pred) || null;
    a.verifiers.forEach(v => out.push({ kind: 'verifier', app: a, key: `v|${a.key}|${v.check}`, id: v.check, subject: v.obligation, title: v.statement || v.obligation, status: v.status, v, mission: missionFor(m => m.kind === 'verifier' && m.subject === v.check) }));
    a.stories.forEach(st => st.criteria.forEach(c => out.push({ kind: 'criterion', app: a, key: `c|${a.key}|${st.story}|${c.id}`, id: `${st.story} ${c.id}`, subject: `${st.story}-${c.id}`, title: c.text || c.id, status: c.stale && c.status === 'approved' ? 'stale' : c.status, c, st,
      mission: missionFor(m => m.kind === 'suite' && m.subject.startsWith(st.story + '-') && m.subject.slice(st.story.length + 1).split('+').includes(c.id)) })));
  }
  return out;
}
function genStepper(st) {
  const i = GEN_STEPS.indexOf(st);
  return `<ol style="list-style:none;display:flex;gap:6px;flex-wrap:wrap;margin:0;padding:0">${GEN_STEPS.map((x, k) => `<li class="small" style="display:flex;align-items:center;gap:6px"><span style="width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;${k <= i ? 'background:var(--navy);color:#fff' : 'border:1px solid var(--line);color:var(--slate-text)'}">${k < i || (k === i && x === 'approved') ? '✓' : k + 1}</span><span${k === i ? ' style="font-weight:700"' : ' class="muted"'}>${x[0].toUpperCase() + x.slice(1)}</span>${k < GEN_STEPS.length - 1 ? '<span class="muted">→</span>' : ''}</li>`).join('')}</ol>`;
}
function viewSuites() {
  const G = LIVE.gen;
  if (!G) { loadGen().then(() => { if (route() === 'suites') render(); }); return '<div class="ph"><div><h1>Generated checks</h1><p class="sub">Loading…</p></div></div>'; }
  const items = genItems(G);
  const n = st => items.filter(x => x.status === st).length;
  const tiles = [['Waiting for you', n('proven'), 'var(--blue)'], ['To prove', n('generated'), 'var(--amber-text)'], ['With the agent core', n('requested') + n('returned'), 'var(--slate-text)'], ['Stale', n('stale'), 'var(--amber-text)'], ['Approved', n('approved'), 'var(--green-text)']];
  const row = x => `<tr><td>${genBadge(x.status)}</td><td><span class="oid">${esc(x.kind === 'verifier' ? x.subject : x.c.id)}</span><b>${esc(x.title)}</b><div class="small muted mono">${esc(x.kind === 'verifier' ? x.id : (x.c.checks || []).join(' · '))}</div>${x.kind === 'verifier' && x.v.feedback && x.status === 'returned' ? `<div class="small" style="color:var(--purple-text)">Returned: ${esc(x.v.feedback)}</div>` : ''}${x.kind === 'criterion' && x.c.feedback && x.status === 'returned' ? `<div class="small" style="color:var(--purple-text)">Returned: ${esc(x.c.feedback)}</div>` : ''}</td>
      <td class="small">${x.mission && ['queued', 'running', 'delivered'].includes(x.mission.status) ? `<span class="s-Requires">Mission ${esc(x.mission.core_mission_id || '#' + x.mission.id)} · ${esc(x.mission.status)}</span>` : x.mission && x.mission.status === 'failed' && ['requested', 'returned'].includes(x.status) ? `<span class="s-Error" title="${esc(x.mission.error || '')}">Mission failed</span>` : (x.kind === 'verifier' ? x.v.proof : x.c.proof) ? (p => `${p.passed}/${p.runs} on <span class="mono">${esc(p.qe)}</span>`)(x.kind === 'verifier' ? x.v.proof : x.c.proof) : '<span class="muted">—</span>'}</td>
      <td style="text-align:right"><button class="btn${x.status === 'proven' ? ' primary' : ''}" data-action="gen-open" data-id="${esc(x.key)}">${x.status === 'proven' ? 'Review and approve…' : x.status === 'generated' ? 'Review and prove…' : 'Open'}</button></td></tr>`;
  const table = list => `<div class="tbl-wrap"><table><thead><tr><th style="width:150px">Status</th><th>Check</th><th style="width:130px">Proof</th><th style="width:190px"></th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`;
  const missionRows = a => (a.missions || []).slice(0, 8).map(m => `<tr><td class="mono small">${esc(m.core_mission_id || '#' + m.id)}</td><td class="small">${esc(m.kind)}</td><td class="mono small">${esc(m.subject)}</td>
      <td class="small"><span class="${m.status === 'applied' ? 's-Connected' : m.status === 'failed' ? 's-Error' : 's-Requires'}">${esc(m.status === 'applied' ? 'delivered and committed' : m.status)}</span>${m.error ? `<div class="muted">${esc(m.error.slice(0, 160))}</div>` : ''}</td>
      <td class="small">${esc((m.agents || []).join(', ') || '—')}${m.commit_sha ? ` · <span class="mono">${esc(m.commit_sha)}</span>` : ''}</td></tr>`).join('');
  const coreLine = a => !a.core ? '<span class="small muted">Agent core not connected: checks for new rules and stories are delivered to the repository by hand.</span>'
    : a.core.error ? `<span class="small s-Error">Agent core unreachable: ${esc(a.core.error)}</span>`
    : `<span class="small">Agent core <b>${esc(a.core.name)} ${esc(a.core.version)}</b>${a.core.implementation === 'reference' ? ' (reference implementation)' : ''} · ${esc((a.core.agents || []).join(', '))}</span>`;
  const apps = G.applications.map(a => {
    const vs = items.filter(x => x.app === a && x.kind === 'verifier');
    return `<section class="card" style="margin-bottom:20px"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h2 style="margin:0">${esc(a.name)}</h2><span class="small muted">QE runs <span class="mono">${esc(a.qe || 'unknown')}</span> · verifiers ${esc(repoLabel(a.repos.verifiers))}${a.repos.suites ? ` · suites ${esc(repoLabel(a.repos.suites))}` : ''}</span></div>
      <div style="margin-top:6px">${coreLine(a)}</div>
      <h3 style="margin:18px 0 4px;font-size:15px">Verifiers for new rules <span class="small muted" style="font-weight:400">policy lane</span></h3>
      <p class="small muted" style="margin:0 0 10px">When a rule is added to the policy repository, PRCheck.live asks the agent core for its verifier. Until you approve it, the rule is NOT ASSESSED and no change it applies to can be READY.</p>
      ${a.missing.length ? `<div class="notice amber" style="margin:0 0 10px"><span>${a.missing.length} obligation${a.missing.length > 1 ? 's have' : ' has'} no verifier and none requested yet: ${a.missing.map(o => esc(o.id)).join(', ')}.</span><button class="btn" data-action="gen-request" data-id="${esc(a.key)}">Request from agent core</button></div>` : ''}
      ${vs.length ? table(vs) : '<p class="small" style="margin:0">Every rule has an active verifier.</p>'}
      ${a.stories.map(st => `<h3 style="margin:22px 0 4px;font-size:15px">${esc(st.story)} · ${esc(st.summary || '')} <span class="small muted" style="font-weight:400">functional lane</span></h3>
        <p class="small muted" style="margin:0 0 10px">${st.generatedBy ? `Generated by ${esc(st.generatedBy.core || 'agent core')} ${esc(st.generatedBy.version || '')}${st.generatedBy.agents ? ` (${st.generatedBy.agents.map(esc).join(', ')})` : ''}` : ''} · <span class="mono">${esc(st.file)}</span></p>
        ${table(items.filter(x => x.st === st))}`).join('')}
      ${(a.missions || []).length ? `<h3 style="margin:22px 0 6px;font-size:15px">Agent core missions</h3><div class="tbl-wrap"><table><thead><tr><th style="width:90px">Mission</th><th style="width:80px">Kind</th><th>Subject</th><th>Status</th><th>Agents · commit</th></tr></thead><tbody>${missionRows(a)}</tbody></table></div>` : ''}
    </section>`;
  }).join('');
  // While the agent core is working, refresh until its deliveries land
  clearTimeout(LIVE.genPoll);
  if (G.applications.some(a => (a.missions || []).some(m => ['queued', 'running', 'delivered'].includes(m.status)))) LIVE.genPoll = setTimeout(() => { if (route() === 'suites') loadGen(true).then(() => { if (route() === 'suites' && !$('#drawer-root .drawer')) render(); }); }, 2000);
  const hist = (G.reviews || []).slice(0, 12).map(r => `<div class="e" style="grid-template-columns:150px minmax(0,1fr)"><div class="w">${esc(fmt(new Date(r.at)))}</div><div><b>${esc(r.action === 'prove' ? (r.result === 'proven' ? 'Proven' : 'Proof failed') : r.action === 'approve' ? 'Approved' : 'Returned')}</b> ${esc(r.subject)} · ${esc(r.by_email)}${r.data && r.data.note ? `<br><span class="muted">${esc(r.data.note)}</span>` : ''}${r.data && r.data.commit ? ` <span class="mono small muted">· commit ${esc(r.data.commit)}</span>` : ''}</div></div>`).join('');
  return `<div class="ph"><div><h1>Generated checks</h1><p class="sub">The agent core writes checks for new rules and for story criteria. Nothing counts toward a verdict until PRCheck.live proves it and you approve it.</p></div>
      <div class="acts"><button class="btn" data-action="gen-refresh">Refresh</button></div></div>
    ${G.error ? `<div class="notice red"><span>${esc(G.error)}</span></div>` : ''}
    <div class="card" style="margin-bottom:20px"><span class="lbl">How a check earns trust</span><div style="margin:8px 0 6px">${genStepper('approved').replace(/✓/g, '·')}</div>
      <p class="small muted" style="margin:0"><b>Requested:</b> PRCheck.live asks the agent core. <b>Generated:</b> the core delivers the code and shows it fails on a broken build. <b>Proven:</b> PRCheck.live runs it ${3} times on QE and it passes every time. <b>Approved:</b> you read the code and approve it; the decision is a commit in the repository.</p></div>
    <div class="tiles fit">${tiles.map(([l, v, c]) => `<div class="tile static"><b class="num" style="color:${c}">${v}</b><span>${l}</span></div>`).join('')}</div>
    ${apps || '<div class="card"><div class="empty">No application has a verifiers or suites repository.</div></div>'}
    ${hist ? `<div class="card"><h2>Decisions</h2><div class="tl">${hist}</div></div>` : ''}`;
}
function genDrawer(key) {
  const x = genItems(LIVE.gen).find(i => i.key === key); if (!x) return ['Not found', ''];
  const e = x.kind === 'verifier' ? x.v : x.c, st = x.status, fault = e.fault, proof = e.proof;
  const sibs = x.kind === 'verifier' && x.v.file ? genItems(LIVE.gen).filter(i => i.kind === 'verifier' && i.app === x.app && i.v.file === x.v.file && i.key !== x.key) : [];
  const code = x.kind === 'verifier' ? [{ check: x.v.check, source: x.v.code }] : (x.c.code || []);
  const head = `<div>${genStepper(st === 'stale' ? 'approved' : st === 'returned' ? 'requested' : st)}</div>
    <div class="kv small" style="grid-template-columns:120px minmax(0,1fr)">
      <div>${x.kind === 'verifier' ? 'Rule' : 'Criterion'}</div><div><b>${esc(x.kind === 'verifier' ? `${x.v.obligation} (${x.v.policy})` : `${x.st.story} ${x.c.id}`)}</b><br>${esc(x.title)}</div>
      <div>Check${code.length > 1 ? 's' : ''}</div><div class="mono">${code.map(c => esc(c.check)).join('<br>')}</div>
      <div>Status</div><div>${esc(GEN_WORD[st] || st)}</div>
      ${(e.generated_by || (x.st && x.st.generatedBy)) ? `<div>Delivered by</div><div>${esc((e.generated_by || x.st.generatedBy).core || 'agent core')} ${esc((e.generated_by || x.st.generatedBy).version || '')}${e.mission ? ` · mission <span class="mono">${esc(e.mission)}</span>` : ''}${(e.generated_by || x.st.generatedBy).agents ? ` · ${esc(((e.generated_by || x.st.generatedBy).agents || []).join(', '))}` : ''}</div>` : ''}
      ${x.mission && ['queued', 'running', 'delivered'].includes(x.mission.status) ? `<div>With the agent core</div><div>Mission <span class="mono">${esc(x.mission.core_mission_id || '')}</span> · ${esc(x.mission.status)}</div>` : ''}
      <div>Fault proof</div><div>${fault ? `From the agent core (${esc(fault.by || 'agent core')}): fails on a seeded fault, <i>${esc(fault.seeded)}</i>` : '<span style="color:var(--amber-text)">None yet. The agent core must show the check fails on a broken build.</span>'}</div>
      <div>PRCheck.live proof</div><div>${proof ? `${proof.passed} of ${proof.runs} runs passed on QE <span class="mono">${esc(proof.qe)}</span> · ${esc(fmt(new Date(proof.at)))}` : 'Not run'}</div>
      ${e.approved_by ? `<div>Approved</div><div>${esc(e.approved_by)} · ${esc(e.approved_at || '')}</div>` : ''}
      ${e.feedback && st === 'returned' ? `<div>Returned</div><div>${esc(e.feedback)}</div>` : ''}
      ${x.kind === 'verifier' && x.v.requested_at ? `<div>Requested</div><div>${esc(fmt(new Date(x.v.requested_at)))} · policy repository ${esc(x.v.policy_commit || '')}</div>` : ''}
    </div>
    ${sibs.length && st !== 'approved' ? `<div class="notice info" style="margin:0"><span>The same file, <span class="mono">${esc(x.v.file)}</span>, holds ${sibs.map(i => `<b>${esc(i.v.check)}</b> (${esc(i.v.obligation)}, ${esc(i.status)})`).join(', ')}. The file is approved as a whole, so every check in it must be proven first.</span></div>` : ''}
    ${st === 'stale' ? '<div class="notice amber" style="margin:0"><span>The criterion changed in Jira after these checks were approved. The agent core regenerates them; until they are approved again the criterion is NOT ASSESSED.</span></div>' : ''}`;
  const src = code.map(c => `<div class="trace" style="margin:0"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2 class="mono" style="font-size:12.5px">${esc(c.check)}</h2></div><div class="rows" style="display:block;white-space:pre;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.5">${esc(c.source || 'The code is not in the repository yet.')}</div></div>`).join('');
  const canProve = ['generated', 'proven'].includes(st), canApprove = st === 'proven', canReturn = ['generated', 'proven', 'requested'].includes(st) && x.kind === 'criterion' ? true : ['generated', 'proven'].includes(st);
  const acts = `<div id="gen-msg"></div>
    ${canApprove || canReturn ? `<div class="field"><label for="gen-note">${canApprove ? 'What you reviewed, or what the agent core should change' : 'What the agent core should change'}</label><textarea id="gen-note" placeholder="${canApprove ? 'For example: read both checks; arrange and assertions match CMP-002' : 'For example: also assert the request stays open'}"></textarea></div>` : ''}
    <div class="btnrow">${canProve ? `<button class="btn${canApprove ? '' : ' primary'}" data-action="gen-act" data-id="prove">${proof ? 'Prove again' : 'Prove on QE'}</button>` : ''}
      ${canApprove ? '<button class="btn primary" data-action="gen-act" data-id="approve">Approve</button>' : ''}
      ${canReturn ? '<button class="btn" data-action="gen-act" data-id="return">Return to agent core</button>' : ''}</div>
    ${st === 'requested' ? '<p class="small muted" style="margin:0">Waiting for the agent core to deliver the check. Nothing to review yet.</p>' : ''}
    ${st === 'approved' ? `<p class="small muted" style="margin:0">Approved checks count on every assessment. Change them by pull request to the ${x.kind === 'verifier' ? 'verifiers' : 'suites'} repository.</p>` : ''}`;
  return [x.kind === 'verifier' ? `Verifier for ${x.v.obligation}` : `${x.st.story} ${x.c.id} checks`, head + acts + `<span class="lbl">Code</span>` + src];
}
async function genAct(action) {
  const x = genItems(LIVE.gen).find(i => i.key === LIVE.genSel); if (!x) return;
  const note = ($('#gen-note') || {}).value || '';
  const msg = (t, tone) => { const m = $('#gen-msg'); if (m) m.innerHTML = `<div class="notice ${tone}" style="margin:0"><span>${esc(t)}</span></div>`; };
  if (action === 'approve' && note.trim().length < 5) return msg('Say what you reviewed (at least 5 characters).', 'red');
  if (action === 'return' && note.trim().length < 10) return msg('Tell the agent core what to change (at least 10 characters).', 'red');
  document.querySelectorAll('[data-action="gen-act"]').forEach(b => { b.disabled = true; });
  if (action === 'prove') msg(`Running the check${x.kind === 'criterion' && x.c.checks.length > 1 ? 's' : ''} 3 times on QE…`, 'info');
  const url = x.kind === 'verifier' ? `/api/ui/suites/${encodeURIComponent(x.app.key)}/verifiers/${action}` : `/api/ui/suites/${encodeURIComponent(x.app.key)}/stories/${encodeURIComponent(x.st.story)}/${encodeURIComponent(x.c.id)}/${action}`;
  const r = await api(url, { method: 'POST', body: { check: x.kind === 'verifier' ? x.v.check : undefined, note } });
  await loadGen(true);
  const [t, h] = genDrawer(LIVE.genSel); openDrawer(t, '', h);
  msg(r.ok ? r.data.message : (r.data.message || `Failed (HTTP ${r.status})`), r.ok ? (action === 'prove' && !r.data.proven ? 'amber' : 'info') : 'red');
  if (route() === 'suites') { const v = $('#view'); if (v) v.innerHTML = viewSuites(); }
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]'); if (!t) return;
  const a = t.dataset.action, id = t.dataset.id;
  if (!['gen-open', 'gen-act', 'gen-refresh', 'gen-request', 'gen-go'].includes(a)) return;
  e.stopImmediatePropagation(); e.preventDefault();
  if (a === 'gen-open') { LIVE.genSel = id; const [tt, h] = genDrawer(id); openDrawer(tt, '', h); }
  if (a === 'gen-act') genAct(id);
  if (a === 'gen-refresh') loadGen(true).then(() => render());
  if (a === 'gen-go') { LIVE.gen = null; go('suites'); }
  if (a === 'gen-request') api(`/api/ui/suites/${encodeURIComponent(id)}/verifiers-request`, { method: 'POST' }).then(r => { toast(r.ok ? `Requested from the agent core: ${r.data.pending.filter(p => p.status === 'requested').map(p => p.obligation).join(', ') || 'nothing new'}${r.data.missions && r.data.missions.length ? ` · ${r.data.missions.length} mission${r.data.missions.length > 1 ? 's' : ''} sent` : ''}.` : (r.data.message || 'Failed.')); return loadGen(true); }).then(() => render());
}, true);
if (!VALID.includes('suites')) VALID.push('suites');
const _buildNav = buildNav;
buildNav = function () { _buildNav(); if (allowed('suites') && !$('#nav a[data-r="suites"]')) { const i = $('#nav a[data-r="integrations"]'); const el = document.createElement('a'); el.href = '#suites'; el.dataset.r = 'suites'; el.textContent = 'Generated checks'; i ? $('#nav').insertBefore(el, i) : $('#nav').appendChild(el); } };
PAGE_NAMES.suites = 'Generated checks';

function viewGaps() {
  const vm = curVM();
  const tones = { 'Violation': 't-red', 'Insufficient': 't-amber', 'Conflicted': 't-purple', 'Unknown impact': 't-neutral', 'Stale evidence': 't-stale' };
  const cards = vm.gaps.map(g => {
    const o = g.o;
    let actions = '';
    if (o) {
      actions += `<button class="btn" data-action="open-evidence" data-id="${esc(o.id)}">Inspect evidence</button>`;
      if (g.type === 'Violation') actions += `<span class="small muted">Finding posted to PR #${vm.change.prNumber} by the <span class="mono">prcheck/assurance</span> check. The producer fixes it and pushes a new revision.</span>`;
      if (o.awaitingVerifier) actions += can('run') ? `<button class="btn primary" data-action="gen-go">Review generated checks</button><span class="small muted">${esc(o.reason)}. Approve it, then re-run.</span>` : `<span class="small muted">${esc(o.reason)}. The Assurance Lead approves it; the change cannot be READY until then.</span>`;
      else if (['Operational', 'Integrity', 'Pending'].includes(o.gapType) && vm.rev.isLatest) actions += gate(can('run'), `<button class="btn primary" data-action="run">Re-run assurance on ${vm.rev.hash}</button>`, NEEDS.run);
      if (o.state === 'INSUFFICIENT' && !o.exception) actions += o.crit === 'Critical' ? '<span class="small muted">Critical obligations cannot be accepted as exceptions (profile rule).</span>'
        : gate(can('run'), `<button class="btn" data-action="exception" data-id="${esc(o.id)}">Propose exception…</button>`, NEEDS.run);
      if (o.state === 'VIOLATED') actions += '<span class="small muted">Violations cannot be waived by an exception (profile rule).</span>';
      if (vm.rev.isLatest && o.state !== 'SUPPORTED') {
        const mine = (vm.change.requests || []).filter(r => r.obligationId === o.id && r.headSha.startsWith(vm.rev.hash));
        const ack = mine.find(r => r.kind === 'acknowledge' && r.status === 'open'), dis = mine.find(r => r.kind === 'dispute' && r.status === 'open');
        if (ME.sysRole === 'Contributor') {
          actions += `<button class="btn" data-action="req-ack" data-id="${esc(o.id)}">${ack ? 'Update acknowledgement…' : 'Acknowledge…'}</button>`;
          actions += dis ? '' : `<button class="btn" data-action="req-dispute" data-id="${esc(o.id)}">Dispute the check…</button>`;
        }
        if (dis && can('run')) actions += `<button class="btn primary" data-action="req-resolve" data-id="${dis.id}">Resolve dispute…</button>`;
      }
    }
    const reqHtml = o ? reqList((vm.change.requests || []).filter(r => r.obligationId === o.id && r.headSha.startsWith(vm.rev.hash)), vm.change) : '';
    const owner = o && o.authority.owner ? `<div class="small muted" style="margin:-4px 0 12px">Rule ${esc(o.authority.id)} is owned by ${esc(o.authority.owner)}${ME.auth.some(x => o.authority.owner.toLowerCase().includes(x.toLowerCase())) ? ' · <b>you hold this authority</b>' : ''}. Changes to it need that owner's approval in vendorpay-policies (CODEOWNERS).</div>` : '';
    return `<article class="gap${g.blocking && !g.exception ? ' blocking' : ''}${g.blocking && !g.exception && g.type !== 'Violation' ? ' amberish' : ''}">
      <div class="t"><span class="badge ${tones[g.type]}">${g.type.toUpperCase()}</span>${g.sub ? `<div class="small muted" style="margin-top:6px">${esc(g.sub)}</div>` : ''}${g.severe ? '<div class="small" style="margin-top:6px;color:var(--red-text);font-weight:700">High severity</div>' : ''}</div>
      <div class="b"><h3>${o ? `<span class="oid">${esc(o.id)}</span>${esc(o.title)}` : esc(g.cause.split('.')[0])}</h3>
        <div class="small muted">${g.blocking ? 'Blocking' : 'Non-blocking'} · Materiality ${g.crit}${g.exception ? ` · Exception ${esc(g.exception.id)} accepted` : ''}</div>
        <dl><dt>Cause</dt><dd>${esc(g.cause)}</dd>
          ${o && o.state === 'VIOLATED' && o.exec ? `<dt>Observed contradiction</dt><dd>Expected <b>${esc(o.exec.expected)}</b>; observed <span class="obs-red">${esc(o.exec.observed)}</span></dd>` : ''}
          <dt>Release consequence</dt><dd>${esc(g.consequence)}</dd>
          ${g.exception ? `<dt>Exception</dt><dd>${esc(g.exception.reason)} · owner ${esc(g.exception.owner)} · scope ${esc(g.exception.scope)} · control: ${esc(g.exception.control)} · expires ${esc(g.exception.expiry)}</dd>` : ''}
        </dl>
        <div class="resolve"><b>What would resolve this?</b> ${esc(g.resolve)}</div>
        ${reqHtml}
        ${owner}
        <div class="btnrow">${actions}</div></div></article>`;
  }).join('');
  return `${staleBanner(vm)}
    <div class="ph"><div><h1>${esc(vm.id)}<span class="sep">·</span>Gaps &amp; uncertainty</h1><p class="sub">Every gap says what would resolve it. Uncertainty is listed, never treated as a pass.</p></div>
      <div class="acts">${dispBadge(vm.disp.code, { lg: true })}${runButton(vm)}</div></div>
    <div class="filters"><nav class="seg" aria-label="Obligation views"><a href="#obligations">Obligations</a><a href="#gaps" class="on" aria-current="page">Gaps &amp; uncertainty (${vm.gaps.length + vm.criteria.filter(c => c.state !== 'SUPPORTED').length + vm.regression.reduce((n, x) => n + x.criteria.filter(c => c.state !== 'SUPPORTED').length, 0) + vm.imported.filter(x => x.state !== 'SUPPORTED').length})</a></nav></div>
    <div class="gaps">${critGapCards(vm)}${regGapCards(vm)}${imGapCards(vm)}${cards || critGapCards(vm) || regGapCards(vm) || imGapCards(vm) ? cards : `<div class="card"><div class="empty"><b>No unresolved gaps identified within current scope.</b>This does not mean the change carries no risk. It means no gap was found inside the assurance boundary.</div></div>`}</div>`;
}

/* ---------- Assurance case ---------- */
function viewCase() {
  const base = curVM(), ch = base.change;
  const key = LIVE.caseRev[base.id] && revisionsOf(ch).some(r => r.key === LIVE.caseRev[base.id]) ? LIVE.caseRev[base.id] : base.rev.key;
  const vm = liveVM(ch, key);
  const caseList = revisionsOf(ch).slice().reverse().map(r => { const v = liveVM(ch, r.key); return `<button class="pitem${r.key === vm.rev.key ? ' on' : ''}" data-action="case-rev" data-id="${r.key}"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b class="mono">${r.key}</b>${dispBadge(v.disp.code, { short: true })}</div><div class="small muted">${v.run ? v.run.id + ' · ' + esc(v.run.at) : 'Not yet assessed'}</div></button>`; }).join('');
  const material = vm.obls.filter(o => o.state !== 'SUPPORTED');
  const tiles = [['Material obligations', vm.obls.length, 'ink'], ['Supported', vm.counts['SUPPORTED'], 'green'], ['Violated', vm.counts['VIOLATED'], 'red'], ['Insufficient', vm.counts['INSUFFICIENT'], 'amber']];
  if (vm.counts['NOT ASSESSED']) tiles.push(['Not assessed', vm.counts['NOT ASSESSED'], 'neutral']);
  const col = { ink: 'var(--ink)', green: 'var(--green-text)', red: 'var(--red-text)', amber: 'var(--amber-text)', purple: 'var(--purple-text)', neutral: 'var(--slate-text)' };
  const key0 = vm.disp.blockers[0] || vm.obls[0];
  const kex = key0 && key0.exec;
  const a = vm.assessment, team = a.context && a.context.team;
  const chain = key0 ? `<div class="chain" aria-label="Assurance chain for ${esc(key0.id)}">
     <div class="n"><span class="lbl">CHANGE</span><b>${esc(vm.id)}</b><span class="mono small">${vm.rev.hash}</span></div><span class="arr">→</span>
     <div class="n"><span class="lbl">OBLIGATION</span><b>${esc(key0.id)}</b>${esc(key0.title.slice(0, 48))}</div><span class="arr">→</span>
     <div class="n"><span class="lbl">AUTHORITY</span><b>${esc(key0.authority.id)}</b>${esc(key0.authority.name.slice(0, 30))}</div><span class="arr">→</span>
     <div class="n"><span class="lbl">VERIFIER</span><b>${esc(key0.verifier.id)}</b><span class="small">${esc(key0.verifier.name.replace(key0.verifier.id, '').trim())}</span></div><span class="arr">→</span>
     <div class="n"><span class="lbl">EXECUTION</span><b class="mono">${kex ? esc(kex.runId) : '—'}</b>${esc(vm.env.split(' · ')[0])}</div><span class="arr">→</span>
     <div class="n hl"><span class="lbl">EVIDENCE</span><b>${kex ? esc(kex.observed.slice(0, 60)) : 'Missing'}</b>${stateBadge(key0.state)}</div></div>` : '';
  const proof = [['Frozen context', a.digests.context, a.integrity.context], ['Verifier evidence', a.digests.evidence, a.integrity.evidence],
    ...(a.digests.functional ? [['Functional evidence', a.digests.functional, a.integrity.functional]] : []),
    ...(a.digests.regression ? [['Regression evidence', a.digests.regression, 'sealed']] : []),
    ...(a.imported || []).filter(x => x.digest).map(x => [x.title, x.digest, 'sealed']), ['PR report', a.digests.report, a.digests.report ? 'sealed' : 'missing']];
  return `${staleBanner(base)}
    <div class="ph"><div><h1>Change Assurance Case</h1><p class="sub small">${esc(vm.id)} &nbsp;·&nbsp; PR #${ch.prNumber} &nbsp;·&nbsp; Revision <span class="mono">${vm.rev.hash}</span> &nbsp;·&nbsp; ${esc(a.id)}</p></div><div class="acts">${dispBadge(vm.disp.code, { lg: true })}</div></div>
    <div class="grid2 grid-case">
    <div>
    <div class="card" style="margin-bottom:20px"><span class="lbl">Disposition rationale</span><div style="font-size:18px;font-weight:700;color:var(--navy);margin:4px 0 6px;text-wrap:balance">${esc(caseHeadline(vm))}</div>
      <p class="small muted" style="margin:0">${esc(vm.disp.reason)} This disposition applies only to the declared assurance boundary and exact evaluated revision.</p>
      ${team ? `<p class="small" style="margin:10px 0 0"><b>Team tests on this commit:</b> ${team.passed}/${team.total} passed. They are context: PRCheck.live's verdict comes only from its own verifiers and the policy repository.</p>` : ''}</div>
    ${lanesPanel(vm)}
    <div class="tiles fit">${tiles.map(([l, n, c]) => `<div class="tile static"><b class="num" style="color:${col[c]}">${n}</b><span>${l}</span></div>`).join('')}</div>
    ${chain}
    ${criteriaPanel(vm)}
    ${regressionPanel(vm)}
    ${importedPanel(vm)}
    <div class="grid-even" style="margin-bottom:20px">
      <div class="card"><h2>Material findings</h2>${material.length ? `<div style="display:flex;flex-direction:column;gap:12px">${material.map(o => `<div style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start"><div>${stateBadge(o.state)}</div><div><span class="oid">${esc(o.id)}</span><b>${esc(o.title)}</b><div class="small muted">${esc(o.state === 'VIOLATED' ? plainViolation(o) : o.gap)} · owner ${esc(o.authority.owner)}</div></div></div>`).join('')}</div>` : '<p class="muted" style="margin:0">No violated, insufficient, conflicted or unassessed obligations within the boundary.</p>'}
        <span class="lbl" style="margin-top:18px">Residual uncertainty</span><p style="margin:0">${vm.gaps.filter(g => g.type === 'Unknown impact').map(g => esc(g.cause)).join('<br>') || 'None identified within current scope.'}</p></div>
      ${boundaryPanel(vm)}
    </div>
    <div class="grid-even">
      <div class="card"><h2>Proof</h2><div class="kv small">${proof.map(([l, d, i]) => `<div>${l}</div><div>${d ? `<a class="mono" href="/api/evidence/${esc(d)}" target="_blank" rel="noopener">${esc(shortD(d))}</a> ${i === 'sealed' ? '<span class="badge t-green">' + ICONS.check + 'SEALED</span>' : i === 'mismatch' ? '<span class="badge t-red">MISMATCH</span>' : ''}` : '—'}</div>`).join('')}
        <div>Policy snapshot</div><div class="mono">${esc(shortD(a.context && a.context.policy && a.context.policy.snapshotDigest))} · policies ${esc((a.context && a.context.policy && a.context.policy.policyRepoCommit) || '—')}</div>
        <div>Verifiers</div><div class="mono">${esc(verName(ch))}@${esc((a.evidence && a.evidence.verifierCommit) || '—')}</div></div>
        <p class="small muted" style="margin:10px 0 0">Each object is stored write-once under its SHA-256 and re-hashed every time it is read.</p></div>
      <div class="card"><h2>Assessment timeline</h2><div class="tl">${a.events.map(e => `<div class="e" style="grid-template-columns:150px minmax(0,1fr)"><div class="w">${esc(fmt(new Date(e.at)))}</div><div><b>${esc(e.step)}</b><br>${esc(e.message)}</div></div>`).join('')}</div></div>
    </div>
    </div>
    <aside><span class="lbl" style="margin-bottom:8px">Cases by revision</span><div class="plist">${caseList}</div></aside>
    </div>`;
}

/* ---------- Home: what each persona sees first ---------- */
function canList(a) {
  const out = ['View changes, obligations, evidence and assurance cases'];
  if (a.sysRole === 'Assurance Lead') out.push('Re-run assurance on any revision', 'Propose exceptions (as a pull request to the policy repository)', 'See integrations and profiles');
  if (a.sysRole === 'Contributor') out.push('Request a re-run from an Assurance Lead');
  if (a.sysRole === 'Admin') out.push('See integrations, users and profiles', 'Not allowed: change evidence, decisions or approvals');
  a.auth.forEach(x => out.push(`Approve ${x} rule and exception changes in the policy repository (CODEOWNERS), never your own`));
  if (a.sysRole === 'Viewer' && !a.auth.length) out.push('Read-only everywhere else');
  return out;
}
function fyLink(key, fn) { FY_GO[key] = fn; return key; }
function openChange(id, rt, obl) { return () => { setChange(id); LIVE.rev[id] = undefined; if (obl) S.selObl[id] = obl; go(rt); }; }
function forYou() {
  const items = []; let head = '', sub = '';
  const vms = allVMs();
  const blocked = vms.filter(v => v.disp.code === 'NOT_READY'), ready = vms.filter(v => ['READY', 'READY_EXC'].includes(v.disp.code)), runningV = vms.filter(v => v.inProgress);
  const vio = v => v.obls.filter(o => o.state === 'VIOLATED');
  runningV.forEach(v => items.push(fyItem('info', '…', `${v.id} · assessment running on ${v.rev.hash}`, `${STATUS_WORD[v.assessment.status] || v.assessment.status}. Results appear here when PRCheck.live decides.`, 'Watch', fyLink('run-' + v.id, openChange(v.id, 'revisions')))));
  if (ME.sysRole === 'Assurance Lead') {
    head = 'Your assurance queue'; sub = 'Requests from contributors, changes PRCheck.live blocked, and what blocks them.';
    vms.forEach(v => openReqs(v.change).forEach(r => {
      const sha = r.headSha.slice(0, 7);
      if (r.kind === 'rerun') items.push(fyItem('warn', '↻', `${v.id} · re-run requested on ${sha}`, `${r.by.name} · ${ago(r.at)}${r.note ? ` · "${r.note}"` : ''}`.slice(0, 200), 'Open revisions', fyLink('rq-' + r.id, openChange(v.id, 'revisions')), true));
      if (r.kind === 'dispute') items.push(fyItem('warn', '?', `${v.id} · ${r.obligationId} check disputed`, `${r.by.name}: "${r.note}"`.slice(0, 200), 'Review', fyLink('rq-' + r.id, openChange(v.id, 'gaps')), true));
      if (r.kind === 'acknowledge') items.push(fyItem('info', '✓', `${v.id} · ${r.obligationId} acknowledged`, `${r.by.name}: "${r.note}"${r.eta ? ` · fix expected ${r.eta}` : ''}`.slice(0, 200), 'Open gaps', fyLink('rq-' + r.id, openChange(v.id, 'gaps'))));
    }));
    if (LIVE.gen) { const gi = genItems(LIVE.gen), wait = gi.filter(x => x.status === 'proven'), prove = gi.filter(x => x.status === 'generated');
      if (wait.length || prove.length) items.push(fyItem('warn', '✎', `${wait.length} generated check${wait.length === 1 ? '' : 's'} waiting for your approval${prove.length ? `, ${prove.length} to prove` : ''}`, gi.filter(x => ['proven', 'generated'].includes(x.status)).map(x => `${x.kind === 'verifier' ? x.subject : x.id}`).join(', ').slice(0, 200), 'Review', fyLink('gen-q', () => go('suites')), true)); }
    else loadGen().then(() => { if (route() === 'home') render(); });
    blocked.forEach(v => items.push(fyItem('bad', '!', `${v.id} · NOT READY on ${v.rev.hash}`, [...vio(v).map(o => `${o.id} ${o.title}`), ...v.criteria.filter(c => c.state === 'FAILED').map(c => `${c.ac} not met: ${c.text}`), ...v.regression.flatMap(st => st.criteria.filter(c => c.state === 'FAILED').map(c => `breaks ${c.story} ${c.ac}`)), ...v.imported.filter(x => x.state === 'FAILED').map(x => `${x.title} outside its gate`)].join('; ').slice(0, 220), 'Open gaps', fyLink('gaps-' + v.id, openChange(v.id, 'gaps')), true)));
    vms.filter(v => v.disp.code === 'INDETERMINATE').forEach(v => items.push(fyItem('warn', '?', `${v.id} · INDETERMINATE`, v.disp.reason.slice(0, 160), 'Open gaps', fyLink('ind-' + v.id, openChange(v.id, 'gaps')), true)));
    ready.forEach(v => items.push(fyItem('ok', '✓', `${v.id} · ${DISP[v.disp.code].label} on ${v.rev.hash}`, `All ${v.obls.length} obligations${v.criteria.length ? ` and ${v.criteria.length} acceptance criteria` : ''} supported. Nothing pending. The PR's merge check is green.`, 'Open case', fyLink('case-' + v.id, openChange(v.id, 'case')))));
  } else if (ME.sysRole === 'Contributor' && !ME.auth.length) {
    head = 'Your changes'; sub = `${[].concat(access().scope).join(', ')} pull requests, and what PRCheck.live found in them.`;
    vms.forEach(v => (v.change.requests || []).filter(r => r.by.email === ME.email).slice(-5).forEach(r => {
      const st = reqState(v.change, r), [w] = REQ_STATE[st];
      const what = r.kind === 'rerun' ? `Your re-run request on ${r.headSha.slice(0, 7)}` : `Your ${r.kind === 'dispute' ? 'dispute of' : 'acknowledgement of'} ${r.obligationId}`;
      const detail = st === 'open' ? (r.kind === 'acknowledge' ? 'Visible to the Assurance Lead and the rule owner.' : 'Waiting for the Assurance Lead.') : `${w}${r.resolved ? ` · ${r.resolved.name}${r.resolved.note ? ': ' + r.resolved.note : ''}` : ''}`;
      items.push(fyItem(st === 'upheld' ? 'bad' : st === 'open' ? 'info' : 'ok', st === 'open' ? '…' : '✓', `${v.id} · ${what}`, detail.slice(0, 200), 'Open', fyLink('my-' + r.id, openChange(v.id, r.kind === 'rerun' ? 'revisions' : 'gaps'))));
    }));
    blocked.forEach(v => { const o = vio(v)[0]; items.push(fyItem('bad', '!', `${v.id} is blocked: ${o ? o.title.toLowerCase() : 'policy violated'}`, o ? `${o.id} (${o.authority.id}) violated on ${v.rev.hash}. ${o.exec ? 'Observed: ' + o.exec.observed : ''}`.slice(0, 200) : v.disp.reason, 'See the evidence', fyLink('ev-' + v.id, openChange(v.id, 'evidence', o && o.id)), true)); });
    blocked.forEach(v => v.imported.filter(x => x.state === 'FAILED').forEach(x => items.push(fyItem('bad', '!', `${v.id} · ${x.title} is outside its gate`, `${x.reason}. ${x.summary}`.slice(0, 220), 'Open gaps', fyLink(`im-${v.id}-${x.id}`, openChange(v.id, 'gaps')), true))));
    blocked.forEach(v => v.regression.forEach(st => st.criteria.filter(c => c.state === 'FAILED').forEach(c => items.push(fyItem('bad', '!', `${v.id} breaks ${c.story} ${c.ac}, which already worked`, `${c.text} Observed on ${v.rev.hash}: ${c.observed}`.slice(0, 220), 'Open gaps', fyLink(`rg-${v.id}-${c.id}`, openChange(v.id, 'gaps')), true)))));
    blocked.forEach(v => v.criteria.filter(c => c.state === 'FAILED').forEach(c => items.push(fyItem('bad', '!', `${v.id} · ${c.ac} of ${c.story} not met`, `${c.text} Observed on ${v.rev.hash}: ${c.observed}`.slice(0, 220), 'Open gaps', fyLink(`ac-${v.id}-${c.id}`, openChange(v.id, 'gaps')), true))));
    ready.forEach(v => items.push(fyItem('ok', '✓', `${v.id} is ${DISP[v.disp.code].label}`, `Revision ${v.rev.hash} passed every obligation${v.criteria.length ? ` and all ${v.criteria.length} acceptance criteria` : ''}. Nothing pending. You can merge.`, 'Open case', fyLink('case-' + v.id, openChange(v.id, 'case')))));
  } else if (ME.auth.length) {
    const area = ME.auth[0];
    head = `${area} rules across active changes`; sub = `You hold Authority: ${area}. Rule and exception changes in your area need your approval in the policy repository.`;
    vms.forEach(v => v.obls.filter(o => o.authority.owner.toLowerCase().includes(area.toLowerCase()) || o.authority.id.startsWith(area.slice(0, 3).toUpperCase()) || (area === 'Finance' && o.authority.id.startsWith('FIN'))).forEach(o => {
      const tone = o.state === 'SUPPORTED' ? 'ok' : o.state === 'VIOLATED' ? 'bad' : 'warn';
      items.push(fyItem(tone, tone === 'ok' ? '✓' : '!', `${v.id} · ${o.id} ${o.title}`, `${o.state} on ${v.rev.hash} · rule ${o.authority.id} v${o.authority.prov.split(' v').pop().split(' ')[0]}`, 'See evidence', fyLink(`a-${v.id}-${o.id}`, openChange(v.id, 'evidence', o.id)), tone === 'bad'));
    }));
    if (!items.length) items.push(`<div class="fy-empty">No ${esc(area)} obligations on active changes.</div>`);
  } else if (ME.sysRole === 'Viewer') {
    head = 'Release readiness'; sub = 'Read-only. What can proceed, and the limits of each disposition.';
    items.push(fyItem('ok', '✓', `${ready.length} change${ready.length === 1 ? '' : 's'} READY`, 'READY means every lane the profile requires is complete for that revision: rules, story promises, nothing pending.', 'Show ready', 'ready'));
    const pend = vms.filter(v => v.disp.code === 'INDETERMINATE');
    if (pend.length) items.push(fyItem('warn', '?', `${pend.length} change${pend.length === 1 ? '' : 's'} not decidable yet`, pend.map(x => `${x.id}: ${x.disp.reason}`).join(' · ').slice(0, 200), 'Show', fyLink('ind-all', () => { S.ccFilter.disp = 'INDETERMINATE'; render(); })));
    items.push(fyItem(blocked.length ? 'bad' : 'ok', blocked.length ? '!' : '✓', `${blocked.length} change${blocked.length === 1 ? '' : 's'} NOT READY`, blocked.length ? 'Blocked: ' + blocked.map(x => `${x.id} ${x.title}`).join(', ') + '.' : 'Nothing is blocked.', 'Show blocked', 'notready', !!blocked.length));
  } else if (ME.sysRole === 'Admin') {
    head = 'Platform administration'; sub = 'You configure PRCheck.live. You cannot see change evidence, run assurance or make decisions.';
    const p = LIVE.platform;
    if (!p) { loadPlatform().then(() => { if (route() === 'home') render(); }); items.push('<div class="fy-empty">Loading platform status…</div>'); }
    else {
      const r = selRepo();
      const down = p.repos.filter(x => !x.environment.version), paused = p.repos.filter(x => x.status === 'paused');
      if (!p.repos.length) items.push(fyItem('bad', '+', 'No application onboarded yet', 'Add an application: connect its GitHub repository, Jira project, policy and verifier repositories, and QE environment.', 'Add application', 'add-app', true));
      else items.push(fyItem(down.length ? 'bad' : 'ok', down.length ? '!' : '✓', `${p.repos.length} application${p.repos.length === 1 ? '' : 's'} onboarded${paused.length ? ` · ${paused.length} paused` : ''} · ${down.length ? `QE not reachable for ${down.map(x => x.app).join(', ')}` : 'every QE environment reachable'}`, `${p.repos.map(x => x.app).join(', ')} · webhooks received: ${p.repos.reduce((n, x) => n + x.webhooks.count, 0)} · reporting via ${p.engine.reporting}`, 'Integrations', 'integrations', true));
      items.push(fyItem('info', 'U', `${(LIVE.members || ACCOUNTS).filter(m => m.status !== 'disabled').length} active members`, 'Roles, authorities and applications are managed under Integrations → Members.', 'Members', 'settings'));
      items.push(fyItem('info', 'P', `${r ? r.policyRepo.policies.length : 0} policies · profile ${r && r.policyRepo.profile ? r.policyRepo.profile.id : '—'}`, `${r ? repoLabel(r.policySource) : '—'}@${r ? r.policyRepo.commit : '—'} · changes need CODEOWNERS approval.`, 'Profiles', 'profiles'));
    }
  }
  if (!items.length) items.push('<div class="fy-empty">Nothing needs you right now.</div>');
  return `<section class="foryou" aria-label="For you"><div class="fyh"><div><h2>${esc(head)}</h2><p>${esc(sub)}</p></div><div>${rchips(ME).replace('margin-left:6px', '')}</div></div>${items.join('')}</section>`;
}

/* ---------- Integrations, profiles, settings: real configuration ---------- */
async function loadPlatform() { if (!can('diagnostics') && ME.sysRole !== 'Admin') return; const r = await api('/api/ui/platform'); if (r.ok) LIVE.platform = r.data; }
const ago = d => (d ? fmt(new Date(d)) : 'never');
function integMap() {
  const p = LIVE.platform; if (!p) return null;
  const r = selRepo(); if (!r) return null;
  const src = r.sources;
  const M = {};
  const add = (group, name, ic, status, html) => { M[name] = { group, ic, status, html }; };
  add('Change producers', 'GitHub', 'G', 'Connected', `<p>Pull requests on <b>${esc(r.github)}</b> start assessments through a signed webhook. ${src.github.adapter === 'api' ? 'Changed files are read with the GitHub API.' : 'Changed files are read from a local clone (demo mode).'}</p><div class="kv small"><div>Webhook URL</div><div class="mono">${esc(p.engine.webhookUrl)}</div><div>Deliveries</div><div>${r.webhooks.count} · last ${esc(ago(r.webhooks.lastAt))}</div><div>Reporting</div><div>${esc(p.engine.reporting)} · status check <span class="mono">prcheck/assurance</span> and one PR comment</div></div>`);
  add('Change producers', 'Azure DevOps', 'A', 'Available'); add('Change producers', 'AI-DLC adapters', 'A', 'Available'); add('Change producers', 'Coding agents', 'C', 'Available');
  add('Enterprise context', 'Jira / ADO Boards', 'J', 'Connected', `<p>The Jira key in the PR title or branch links the story and its acceptance criteria to the change.</p><div class="kv small"><div>Project</div><div>${esc(r.jiraProject)}</div><div>Source</div><div>${src.jira.adapter === 'cloud' ? 'Jira Cloud REST API' : 'Fixture files (demo): ' + esc(src.jira.path || '')}</div></div>`);
  add('Enterprise context', 'Confluence', 'C', 'Available');
  add('Enterprise context', 'Policy repositories', 'P', 'Connected', `<p>Rules come from <b>${esc(repoLabel(r.policySource))}</b>, owned per area through CODEOWNERS. Every assessment freezes the exact policy versions it used.</p><div class="kv small"><div>Commit</div><div class="mono">${esc(r.policyRepo.commit || '—')}</div><div>Policies</div><div>${r.policyRepo.policies.map(x => `${esc(x.id)} v${esc(x.version)}`).join(', ')}</div><div>Exceptions in force</div><div>${r.policyRepo.exceptions.length || 'None'}</div></div>`);
  add('Enterprise context', 'Architecture records', 'A', 'Available');
  const checks = Object.values(r.verifiers.catalog || {}).reduce((n, v) => n + Object.keys(v.checks || {}).length, 0);
  add('Verification', 'Test frameworks', 'T', 'Connected', `<p>PRCheck.live's own Playwright verifiers, kept outside the application repository so a team cannot weaken the checks on its own change.</p><div class="kv small"><div>Repository</div><div class="mono">${esc(repoLabel(r.verifierSource))}@${esc(r.verifiers.commit || '—')}</div><div>Verifiers</div><div>${Object.entries(r.verifiers.catalog || {}).map(([k, v]) => `${esc(k)} ${esc(v.name)}`).join(' · ')}</div><div>Checks</div><div>${checks}</div><div>Runner</div><div>${esc(r.verifiers.adapter)}</div></div>`);
  const fn = r.functional, ch = r.channels || {};
  add('Verification', 'Assurance suites', 'S', fn ? 'Connected' : 'Requires', fn
    ? `<p>Functional and regression suites per story, generated by the agent core, proven, and approved by an Assurance Lead. Owned by PRCheck.live: the application team cannot push to it.</p><div class="kv small"><div>Repository</div><div class="mono">${esc(repoLabel(fn.repository))}@${esc(fn.commit || '—')}</div><div>Produced by</div><div>${fn.adapter === 'agent-core' ? 'myDiya agent core' : 'Approved suites from the repository'}${fn.coreVersion ? ' · core ' + esc(fn.coreVersion) : ''} · budget ${esc(fn.budget)} s</div><div>Story suites</div><div>${fn.suites.length ? fn.suites.map(x => `${esc(x.story)}: ${x.approved}/${x.criteria} criteria approved${x.approvedBy ? ' by ' + esc(x.approvedBy) : ''}`).join('<br>') : 'None yet: stories stay NOT ASSESSED'}</div><div>Team automation</div><div>${r.team ? `<span class="mono">${esc(repoLabel(r.team.repository))}</span> · read-only, context for the agents` : 'None'}</div></div>`
    : '<p>No suites repository. Only the policy lane runs; a profile that requires the functional lane makes every change INDETERMINATE.</p>');
  add('Verification', 'Channels', 'C', ch.ui || ch.api || ch.mcp ? 'Connected' : 'Requires', `<p>What the functional and regression lanes test on QE.</p><div class="kv small"><div>Web UI</div><div>${ch.ui ? `<span class="mono">${esc(ch.ui.url || r.environment.base_url)}</span> · ${esc((ch.ui.browsers || ['chromium']).join(', '))}` : 'Off'}</div><div>API</div><div>${ch.api ? `<span class="mono">${esc(ch.api.base_url || r.environment.base_url)}</span>${ch.api.spec ? ' · specification ' + esc(ch.api.spec) : ' · no specification'}` : 'Off'}</div><div>MCP</div><div>${ch.mcp ? `<span class="mono">${esc(ch.mcp.url)}</span>` : 'Off'}</div></div>`);
  add('Verification', 'Jira Xray', 'X', 'Connected', `<p>The team's own test results for each commit, in Xray's JUnit import format. Shown as context; they never decide the disposition.</p><div class="kv small"><div>Source</div><div>${esc(src.xray.adapter)} · ${esc(src.xray.path)}</div></div>`);
  const v = r.environment.version;
  add('Verification', 'QE environment', 'Q', v ? 'Connected' : 'Error', v ? `<p>Verifiers run only when this environment reports the PR's exact commit.</p><div class="kv small"><div>URL</div><div class="mono">${esc(r.environment.base_url)}</div><div>Running</div><div class="mono">${esc(v.app)} ${esc(v.version)} · ${esc(v.gitSha)}</div><div>Environment</div><div>${esc(v.environment)}</div></div>` : `<p class="s-Error">Not reachable at ${esc(r.environment.base_url)}</p><p>New assessments wait for it, then end INDETERMINATE if it never reports the commit. Existing dispositions stay valid.</p>`);
  add('Verification', 'Evidence store', 'E', 'Connected', `<p>Write-once, content-addressed storage. Every object is re-hashed when read.</p><div class="kv small"><div>Objects</div><div>${p.evidence.objects} · ${(p.evidence.bytes / 1024).toFixed(0)} KB</div><div>Location</div><div class="mono">${esc(p.evidence.store)}</div></div>`);
  add('Delivery', 'CI/CD', 'C', 'Connected', `<p>A GitHub Actions job deploys each PR commit to QE and runs the team's tests.</p>`);
  add('Delivery', 'Release systems', 'R', 'Available'); add('Delivery', 'Change management', 'C', 'Available'); add('Delivery', 'Incident systems', 'I', 'Available');
  return M;
}
function selRepo() {
  const p = LIVE.platform; if (!p || !p.repos.length) return null;
  return p.repos.find(r => r.key === LIVE.appSel) || p.repos[0];
}
function appsTable() {
  const apps = LIVE.apps || [], admin = ME.sysRole === 'Admin';
  if (!apps.length) return '';
  const src = a => a.origin === 'ui' ? `Onboarded by ${esc(a.createdBy || '—')}${a.updatedAt ? ` · updated ${esc(ago(a.updatedAt))}` : ''}` : 'Configuration file';
  return `<div class="card" style="padding:0;margin-bottom:22px"><div style="padding:16px 20px 10px"><h2 style="margin:0">Applications</h2><p class="small muted" style="margin:4px 0 0">Each application has its own repository, Jira project, policy and verifier repositories, and QE environment.</p></div>
    <div class="tbl-wrap" style="border:0;border-top:1px solid var(--line);border-radius:0 0 12px 12px"><table><thead><tr><th>Application</th><th>GitHub</th><th>Jira</th><th>QE environment</th><th>Source</th><th>Status</th>${admin ? '<th></th>' : ''}</tr></thead><tbody>
    ${apps.map(a => `<tr><td><b>${esc(a.name)}</b><div class="mono small muted">${esc(a.key)}</div></td><td class="mono small">${esc(a.github)}</td><td>${esc(a.jiraProject)}</td><td class="mono small">${esc(a.environment)}</td><td class="small">${src(a)}</td>
      <td><span class="${a.status === 'paused' ? 's-Requires' : 's-Connected'}">${a.status === 'paused' ? 'Paused' : 'Active'}</span></td>
      ${admin ? `<td><div class="btnrow" style="flex-wrap:nowrap">${a.origin === 'ui' ? `<button class="btn" data-action="app-edit" data-id="${esc(a.key)}">Edit</button><button class="btn" data-action="app-status" data-id="${esc(a.key)}">${a.status === 'paused' ? 'Resume' : 'Pause'}</button>` : '<span class="small muted">Edit prcheck.config.yaml</span>'}</div></td>` : ''}</tr>`).join('')}
    </tbody></table></div></div>`;
}
/* ---------- Members: managed through the engine ---------- */
async function loadMembers() { const r = await api('/api/ui/members'); if (r.ok) { LIVE.members = r.data.members; LIVE.memberApps = r.data.applications.map(a => ({ key: a.key, name: a.name })); } }
/* The applications the signed-in member works on, from the engine: one card each on Home. */
function myApps() { return ((LIVE.access && LIVE.access.applications) || []).map(a => ({ key: a.key, name: a.name, github: a.github, status: a.status })); }
/* Bulk import: the engine validates every row and applies only the valid ones. */
function importApps() { return LIVE.memberApps || []; }
async function importRun(rows, dryRun) {
  const r = await api('/api/ui/members/import', { method: 'POST', body: { rows, dryRun } });
  return r.ok ? r.data : { error: r.data.message || `Import failed (HTTP ${r.status}).` };
}
function exportMembers() { return LIVE.members || []; }
function afterImport() { LIVE.members = null; LIVE.users = null; render(); }
async function saveMember(id) {
  const v = readMemberForm(), creating = id === 'new';
  const e = validateMember(v, creating, (LIVE.members || []).map(m => m.email));
  if (Object.keys(e).length) return showMemberErrors(e);
  const btn = $('[data-action="mem-save"]'); if (btn) btn.disabled = true;
  const r = await api(creating ? '/api/ui/members' : `/api/ui/members/${encodeURIComponent(id)}`, { method: creating ? 'POST' : 'PUT', body: v });
  if (btn) btn.disabled = false;
  if (!r.ok) return showMemberErrors(r.data.errors, r.data.errors ? '' : (r.data.message || `Not saved (HTTP ${r.status}).`));
  $('#drawer-root').innerHTML = '';
  toast(creating ? `${v.name} added. They see ${v.sysRole === 'Admin' ? 'platform settings only' : v.allApps ? 'all applications' : v.apps.length + ' application' + (v.apps.length === 1 ? '' : 's')} after signing in.` : `${v.name} updated.`);
  LIVE.members = null; LIVE.users = null; render();
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]'); if (!t) return;
  const a = t.dataset.action, id = t.dataset.id;
  const stop = () => { e.stopImmediatePropagation(); e.preventDefault(); };
  switch (a) {
    case 'mem-add': stop(); openDrawer('Add member', 'Role, authority and applications', memberForm(null, LIVE.memberApps || [])); break;
    case 'mem-edit': stop(); { const m = (LIVE.members || []).find(x => x.email === id); openDrawer(`Edit ${m.name}`, esc(m.email), memberForm(m, LIVE.memberApps || [])); } break;
    case 'mem-save': stop(); saveMember(id); break;
    case 'mem-status': stop(); { const m = (LIVE.members || []).find(x => x.email === id); const next = m.status === 'disabled' ? 'active' : 'disabled';
      api(`/api/ui/members/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status: next } }).then(r => {
        toast(r.ok ? (next === 'disabled' ? `${m.name} deactivated: they can no longer sign in.` : `${m.name} reactivated.`) : (r.data.message || 'Not changed.'));
        LIVE.members = null; LIVE.users = null; render(); }); } break;
  }
}, true);

async function loadApps() { const r = await api('/api/ui/applications'); if (r.ok) LIVE.apps = r.data.applications; }
function viewIntegrations() {
  if (!LIVE.platform || !LIVE.apps) { Promise.all([LIVE.platform ? null : loadPlatform(), LIVE.apps ? null : loadApps()]).then(() => { if (route() === 'integrations' && LIVE.platform && LIVE.apps) render(); }); return `<div class="ph"><div><h1>Integrations</h1><p class="sub">Loading live status…</p></div></div>`; }
  const admin = ME.sysRole === 'Admin';
  const head = `<div class="ph"><div><h1>Integrations</h1><p class="sub">Live status of the systems PRCheck.live reads from and reports to, per application.</p></div><div class="acts"><button class="btn" data-action="refresh-platform">Refresh</button>${admin ? '<button class="btn primary" data-action="app-add">Add application</button>' : ''}</div></div>`;
  const r = selRepo();
  if (!r) return head + `<div class="card" style="max-width:680px;margin:30px auto;text-align:center;padding:36px 32px"><h2 style="margin:0 0 8px">No application onboarded yet</h2><p class="muted" style="margin:0 0 18px">Connect an application's GitHub repository, Jira project, team results, policy and verifier repositories, and QE environment. Each connection is tested before it is saved.</p>${admin ? '<button class="btn primary" data-action="app-add">Add application</button>' : '<p class="small muted">An Admin onboards applications.</p>'}</div>`;
  const M = integMap(), groups = ['Change producers', 'Enterprise context', 'Verification', 'Delivery'];
  const err = M['QE environment'].status === 'Error' ? `<div class="notice red"><span><b>${esc(r.app)}: QE environment not reachable.</b> New assessments cannot verify until it reports the PR's commit at /version.</span></div>` : '';
  const paused = r.status === 'paused' ? `<div class="notice amber"><span><b>${esc(r.app)} is paused.</b> Pull request webhooks are acknowledged and ignored until an Admin resumes it.</span></div>` : '';
  const picker = LIVE.platform.repos.length > 1 ? `<div class="btnrow" role="group" aria-label="Application" style="margin:0 0 14px"><span class="small muted">Showing</span>${LIVE.platform.repos.map(x => `<button class="btn${x.key === r.key ? ' navy' : ''}" data-action="app-sel" data-id="${esc(x.key)}" aria-pressed="${x.key === r.key}">${esc(x.app)}</button>`).join('')}</div>` : '';
  const mem = admin ? (LIVE.members ? membersSection(LIVE.members, LIVE.memberApps) : (loadMembers().then(() => { if (route() === 'integrations') render(); }), '')) : '';
  return `${head}${appsTable()}${mem}${picker}${err}${paused}
    <div class="integ">${groups.map(g => `<section class="col" aria-label="${g}"><h2>${g}</h2>${Object.entries(M).filter(([, x]) => x.group === g).map(([n, x]) => `<button class="itile" data-action="integ" data-id="${esc(n)}"><span class="ic">${x.ic}</span><span><b>${esc(n)}</b><small class="s-${x.status}">${x.status}</small></span></button>`).join('')}</section>`).join('')}</div>`;
}
function integDetail(name) {
  const M = integMap() || {}; const x = M[name];
  if (!x) return [name, '<p>Unknown integration.</p>', ''];
  return [name, x.html || `<p>${esc(name)} is available for this organisation but not connected. Connecting it needs an administrator to supply credentials and scope.</p><div class="kv small"><div>Status</div><div>Available</div><div>Role</div><div>${esc(x.group)}</div></div><p class="small muted">Nothing from ${esc(name)} contributes evidence to any current assurance case.</p>`, x.group];
}
function viewProfiles() {
  if (!LIVE.platform) { loadPlatform().then(() => { if (route() === 'profiles') render(); }); return `<div class="ph"><div><h1>Assurance profiles</h1><p class="sub">Loading…</p></div></div>`; }
  const r = selRepo();
  if (!r) return `<div class="ph"><div><h1>Assurance profiles</h1><p class="sub">No application onboarded yet. Profiles come from each application's policy repository.</p></div></div>`;
  const pr = r.policyRepo.profile || {}, pols = r.policyRepo.policies;
  const rules = (pr.disposition || []).map(d => `${d.when} → ${String(d.result).replace(/_/g, ' ')}`);
  const mappings = pols.flatMap(p => p.obligations.map(o => [`${o.id}`, `${o.evidence.verifier}/${o.evidence.check}`]));
  return `<div class="ph"><div><h1>Assurance profiles</h1><p class="sub">Profiles decide which obligations matter, who says so, what blocks, and which verifiers produce evidence. Source: ${esc(repoLabel(r.policySource))}@${esc(r.policyRepo.commit || '—')}.</p></div></div>
    <div class="grid2 grid-side">
      <div class="plist">${LIVE.platform.repos.map(x => { const xp = x.policyRepo.profile || {}; return `<button class="pitem${x.key === r.key ? ' on' : ''}" data-action="app-sel" data-id="${esc(x.key)}"><b>${esc(xp.title || xp.id || 'Profile')}</b><div class="small muted">Used by ${esc(x.app)} (${esc(x.github)})</div></button>`; }).join('')}</div>
      <div class="card"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start"><div><h2 style="margin:0">${esc(pr.title || pr.id)}</h2><p class="small muted" style="margin:4px 0 0">Profile <span class="mono">${esc(pr.id)}</span> · Owner ${esc(pr.owner || '')} · changed only through a reviewed pull request.</p></div>${gate(can('admin'), `<button class="btn" data-action="profile-version">New version</button>`, NEEDS.admin)}</div>
        <div class="kv small" style="margin-top:16px;grid-template-columns:190px minmax(0,1fr)">
          <div>Authorities</div><div>${esc((pr.authorities || []).join(', '))}</div>
          <div>Policies</div><div>${pols.map(p => `<span class="mono">${esc(p.id)}</span> v${esc(p.version)} · ${esc(p.title)} · <span class="muted">${esc(p.owner)}, ${esc(p.severity)}</span>`).join('<br>')}</div>
          <div>Disposition rules</div><div>${rules.map(esc).join('<br>')}</div>
          <div>Verifier mappings</div><div>${mappings.map(([a, b]) => `${esc(a)}: <span class="mono">${esc(b)}</span>`).join('<br>')}</div>
          <div>Exceptions</div><div>${r.policyRepo.exceptions.length ? r.policyRepo.exceptions.map(x => `${esc(x.id)} on ${esc(x.policy)} until ${esc(x.expires)}`).join('<br>') : 'None in force. Exceptions are files in exceptions/&lt;authority&gt;/, approved by that authority.'}</div></div></div></div>`;
}
function viewSettings() {
  const sw = (key, title, desc, checked) => `<label class="switch"><input type="checkbox" data-change="${key}"${checked ? ' checked' : ''}><span><b>${title}</b><br><span class="small muted">${desc}</span></span></label>`;
  if (can('admin') && !LIVE.users) api('/api/ui/users').then(r => { if (r.ok) { LIVE.users = r.data.users; if (route() === 'org-settings') render(); } });
  if ((can('admin') || can('diagnostics')) && !LIVE.platform) loadPlatform().then(() => { if (route() === 'org-settings') render(); });
  const users = can('admin') ? `<div class="card" style="margin-top:20px;padding:0"><div style="padding:18px 22px 8px"><h2 style="margin:0">Users and roles</h2><p class="small muted" style="margin:4px 0 0">Enforced by the server on every request. Admins configure the platform but cannot see evidence or make decisions.</p></div>
    <div class="tbl-wrap" style="border:0;border-top:1px solid var(--line);border-radius:0 0 12px 12px"><table class="persona-tbl"><thead><tr><th>Person</th><th>Persona</th><th>Role and authority</th><th>Uses PRCheck.live to</th></tr></thead><tbody>
    ${(LIVE.users || []).map(a => `<tr${a.email === ME.email ? ' style="background:#EEF2FD"' : ''}><td><b>${esc(a.name)}</b>${a.email === ME.email ? ' <span class="small muted">(you)</span>' : ''}<div class="mono small muted">${esc(a.email)}</div></td><td>${esc(a.role)}</td><td>${rchips(a).replace('margin-left:6px', '')}</td><td>${esc(a.job)}</td></tr>`).join('')}
    <tr><td><b>Producer</b><div class="small muted">human developer or AI agent</div></td><td>Change producer</td><td><span class="rchip">No login</span></td><td>Receives findings on the pull request and pushes fixes</td></tr></tbody></table></div></div>`
    : `<div class="card" style="margin-top:20px"><h2>Your access</h2><p class="small" style="margin:0 0 8px">${rchips(ME).replace('margin-left:6px', '')}</p><ul class="small" style="margin:0;padding-left:18px">${canList(ME).map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="small muted" style="margin:10px 0 0">Roles are assigned by your PRCheck.live admin and enforced by the server.</p></div>`;
  const p = LIVE.platform;
  const engine = p ? `<div class="card"><h2>Engine</h2><div class="kv small"><div>Public URL</div><div class="mono">${esc(p.engine.publicUrl)}</div><div>Webhook</div><div class="mono">${esc(p.engine.webhookUrl)}</div><div>Reporting</div><div>${esc(p.engine.reporting)}</div><div>Engine commit</div><div class="mono">${esc(p.engine.engineCommit || '—')}</div><div>Evidence objects</div><div>${p.evidence.objects}</div></div></div>` : '';
  return `<div class="ph"><div><h1>Settings</h1><p class="sub">Organisation preferences, users and roles, and engine details.</p></div></div>
    <div class="grid-even">
      <div class="card"><h2>Display</h2>${sw('set-producer', 'Show producer provenance', 'Shows who produced each change. Assurance works the same with this hidden.', S.showProducer)}</div>
      ${engine}
    </div>
    ${users}`;
}

/* ---------- Re-run: a real assessment, stages streamed from the engine ---------- */
const STAGES = [['intake', 'Receiving revision'], ['gather', 'Gathering GitHub, Jira, Xray and policies'], ['environment', 'Confirming QE runs this commit'], ['freeze', 'Freezing context'], ['verify', 'Executing independent verifiers'], ['functional', 'Verifying acceptance criteria (functional lane)'], ['regression', 'Re-verifying earlier stories (regression lane)'], ['imported', 'Collecting results from other tools'], ['decide', 'Deriving disposition'], ['report', 'Reporting to the pull request']];
async function startRun() {
  const vm = curVM();
  if (!vm || !can('run') || !vm.rev.isLatest || (S.running && !S.running.done)) return;
  const r = await api(`/api/ui/assessments/${encodeURIComponent(vm.assessment.id)}/rerun`, { method: 'POST' });
  if (!r.ok) { toast(r.data.message || 'Could not start the assessment.'); return; }
  S.running = { id: r.data.assessmentId, changeId: vm.id, sha: vm.rev.hash, done: false, events: [], status: 'queued', result: null };
  openDrawer('Assurance run', `${esc(vm.id)} · revision <span class="mono">${vm.rev.hash}</span> · ${esc(r.data.assessmentId)}`, runPanel(), { locked: true });
  clearInterval(LIVE.runPoll);
  LIVE.runPoll = setInterval(pollRun, 1500);
  pollRun();
}
async function pollRun() {
  const R = S.running; if (!R || R.done) { clearInterval(LIVE.runPoll); return; }
  const r = await api(`/api/assessments/${encodeURIComponent(R.id)}`);
  if (!r.ok) return;
  R.events = r.data.events; R.status = r.data.assessment.status;
  if (['done', 'failed'].includes(R.status)) {
    R.done = true; clearInterval(LIVE.runPoll);
    await loadLive(); LIVE.rev[R.changeId] = undefined;
    R.result = { disp: (vmFor(R.changeId) || {}).disp };
    render();
  }
  updRun();
}
function runPanel() {
  const R = S.running; if (!R) return '';
  const seen = new Set((R.events || []).map(e => e.step));
  const icon = st => `<span class="st ${st}" aria-hidden="true">${st === 'done' ? '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M2.5 6.3l2.3 2.3 4.7-5" fill="none" stroke="#fff" stroke-width="2"/></svg>' : ''}</span>`;
  let current = STAGES.findIndex(([k]) => !seen.has(k));
  if (R.done) current = STAGES.length;
  const failedStep = R.status === 'failed';
  let html = `<ol class="stages">${STAGES.map(([k, name], i) => {
    const st = i < current ? 'done' : i === current ? (failedStep ? 'fail' : 'run') : 'pending';
    const detail = (R.events || []).filter(e => e.step === k).map(e => e.message).join(' · ');
    return `<li>${icon(st)}<div><div class="nm">${esc(name)}</div><div class="dt">${esc(detail || (st === 'run' ? 'in progress' : ''))}</div></div></li>`;
  }).join('')}</ol>`;
  if (R.done) {
    if (failedStep) html += `<div class="notice red" style="margin:0"><span><b>Assessment failed.</b> ${esc(((R.events || []).find(e => e.step === 'error') || {}).message || '')}</span></div>`;
    else if (R.result && R.result.disp) html += `<div class="card" style="padding:16px 18px"><span class="lbl">Result</span><div style="margin:6px 0 8px">${dispBadge(R.result.disp.code, { lg: true })}</div><p class="small" style="margin:0">${esc(R.result.disp.reason)}</p></div>`;
    html += `<div class="btnrow"><button class="btn navy" data-action="run-done" data-id="obligations">View obligations</button><button class="btn" data-action="run-done" data-id="case">View assurance case</button><button class="btn" data-action="close-drawer">Close</button></div>`;
  } else html += `<p class="small muted" style="margin:0">Stages come from the engine as they happen. The verifiers act on the live QE environment, so this takes about a minute.</p>`;
  return html;
}

/* ---------- Exception proposal: a real file for the policy repository ---------- */
function exceptionDrawer(o, vm) {
  const today = new Date(), exp = new Date(today.getTime() + 14 * 864e5).toISOString().slice(0, 10);
  const area = (o.authority.owner.match(/@[\w.-]+\/([\w.-]+)/) || [])[1] || 'finance-controls';
  const folder = area.split('-')[0];
  const yaml = `apiVersion: prcheck/v1\nkind: Exception\nid: EXC-0001\npolicy: ${o.authority.id}\nobligations: [${o.id}]\nscope:\n  repository: ${vm.change.repository}\n  jira: ${vm.id}\nreason: <why this change may ship before the obligation is met>\ncompensating_control: <what reduces the risk meanwhile>\napproved_by: "${o.authority.owner}"\ngranted: ${today.toISOString().slice(0, 10)}\nexpires: ${exp}\n`;
  return `<p class="small" style="margin:0">Exceptions are not clicked into existence. They are a file in <b>${esc(polName(vm.change))}</b>, added by pull request and approved by the rule's owner (<span class="mono">${esc(o.authority.owner)}</span>) through CODEOWNERS. The validator rejects exceptions to rules that allow none, and anything longer than the rule's maximum.</p>
    <div class="trace"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2>exceptions/${esc(folder)}/EXC-0001.yaml</h2><button class="copy" data-action="copy" data-text="${esc(yaml)}">Copy</button></div><div class="rows" style="display:block;white-space:pre-wrap;font-family:var(--mono);font-size:12.5px">${esc(yaml)}</div></div>
    <p class="small muted" style="margin:0">After the pull request merges, re-run assurance. The exception then shows here, in the assurance case and on the pull request.</p>`;
}

/* ---------- Actions the live product handles differently ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]'); if (!t) return;
  const a = t.dataset.action, id = t.dataset.id;
  const stop = () => { e.stopImmediatePropagation(); e.preventDefault(); };
  switch (a) {
    case 'run': stop(); if (!can('run')) { toast('Running assurance needs the Assurance Lead role.'); break; } startRun(); break;
    case 'request-rerun': stop(); { const [t, h] = reqDrawer('rerun'); openDrawer(t, '', h); } break;
    case 'req-ack': stop(); { const [t, h] = reqDrawer('ack', id); openDrawer(t, '', h); } break;
    case 'req-dispute': stop(); { const [t, h] = reqDrawer('dispute', id); openDrawer(t, '', h); } break;
    case 'req-resolve': stop(); { const [t, h] = reqDrawer('resolve', id); openDrawer(t, '', h); } break;
    case 'req-send': stop(); reqSend(id); break;
    case 'view-rev': stop(); LIVE.rev[S.changeId] = id; LIVE.caseRev[S.changeId] = id; render(); break;
    case 'case-rev': stop(); LIVE.caseRev[S.changeId] = id; render(); break;
    case 'exception': stop(); { const vm = curVM(); const o = vm.obls.find(x => x.id === id); openDrawer('Propose exception', `${esc(o.id)} · through the policy repository`, exceptionDrawer(o, vm)); } break;
    case 'refresh-platform': stop(); LIVE.platform = null; LIVE.apps = null; render(); break;
    case 'profile-version': stop(); toast(`Profiles change through a pull request on ${repoLabel((selRepo() || {}).policySource) || 'the policy repository'}, approved by its CODEOWNERS.`); break;
    case 'route': case 'decide': case 'return-finding': case 'import-rev': case 'revoke': case 'exc-approve': case 'exc-reject':
      stop(); toast('In the live product this happens on GitHub: findings go to the PR automatically, new commits arrive by webhook, and rules and exceptions change by pull request to the policy repository.'); break;
    case 'flow': case 'reset-arm': case 'reset-do': case 'reset-cancel': stop(); break;
    case 'signout': stop(); api('/api/ui/logout', { method: 'POST', allow401: true }).then(() => { stopPolling(); LIVE.platform = null; LIVE.users = null; LIVE.members = null; LIVE.access = null; $('#acct-pop').hidden = true; $('#drawer-root').innerHTML = ''; showLogin({ t: 'info', m: 'You have signed out.' }); }); break;
  }
}, true);
document.addEventListener('change', e => {
  const k = e.target.dataset && e.target.dataset.change; if (!k) return;
  if (k === 'ctx-rev') { e.stopImmediatePropagation(); LIVE.rev[S.changeId] = e.target.value; LIVE.caseRev[S.changeId] = e.target.value; render(); }
  if (k === 'ctx-change') { e.stopImmediatePropagation(); setChange(e.target.value); render(); }
}, true);

/* ---------- Sign-in against the engine ---------- */
async function submitLogin() {
  const email = $('#lg-email').value.trim().toLowerCase(), pass = $('#lg-pass').value;
  let ok = true;
  const setErr = (id, inp, m) => { $(id).textContent = m; $(inp).setAttribute('aria-invalid', m ? 'true' : 'false'); if (m) ok = false; };
  setErr('#lg-e-email', '#lg-email', !email ? 'Enter your work email.' : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? 'Enter an email address like name@company.com.' : '');
  setErr('#lg-e-pass', '#lg-pass', !pass ? 'Enter your password.' : '');
  if (!ok) { (email && /@/.test(email) ? $('#lg-pass') : $('#lg-email')).focus(); return; }
  const btn = $('#lg-submit'); btn.disabled = true; btn.innerHTML = '<span class="st run sm" aria-hidden="true"></span>Signing in…';
  const r = await api('/api/ui/login/password', { method: 'POST', body: { email, password: pass }, allow401: true });
  if (!r.ok) {
    stepSignIn({ t: 'err', email, m: (r.data.attempts || 0) >= 3 ? 'Email or password is incorrect. Use one of the demo accounts below.' : 'Email or password is incorrect. Check both and try again.' });
    $('#lg-pass').focus(); return;
  }
  const acct = ACCOUNTS.find(a => a.email === email) || r.data.account;
  pending = { ...acct, password: pass, remember: $('#lg-remember').checked };
  stepCode();
}
async function submitCode() {
  const code = [...document.querySelectorAll('#otp input')].map(i => i.value).join('');
  if (code.length < 6) { $('#lg-e-otp').textContent = 'Enter all 6 digits.'; return; }
  const btn = $('#otp-submit'); if (btn.disabled) return; btn.disabled = true; btn.innerHTML = '<span class="st run sm" aria-hidden="true"></span>Verifying…';
  const r = await api('/api/ui/login', { method: 'POST', body: { email: pending.email, password: pending.password, code, remember: pending.remember }, allow401: true });
  if (!r.ok) {
    btn.disabled = false; btn.textContent = 'Verify and continue';
    const g = $('#otp'); g.classList.remove('bad'); void g.offsetWidth; g.classList.add('bad');
    $('#lg-e-otp').textContent = "That code didn't match. Check your authenticator and try again.";
    document.querySelectorAll('#otp input').forEach(i => i.value = ''); $('#otp input').focus(); return;
  }
  pending = null;
  await enterLive(r.data.account, true, r.data.access);
}
async function enterLive(account, fresh, acc) {
  ME = { ...(ACCOUNTS.find(a => a.email === account.email) || {}), ...account };
  LIVE.access = acc || null;
  $('#login').hidden = true; document.querySelector('.app').hidden = false;
  setUserChrome();
  LIVE.sig = ''; await loadLive();
  if (LIVE.deep) {
    const ch = LIVE.changes.find(c => c.assessments.some(a => a.id === LIVE.deep));
    if (ch) { const a = ch.assessments.find(x => x.id === LIVE.deep); setChange(ch.id); LIVE.rev[ch.id] = a.headSha.slice(0, 7); LIVE.caseRev[ch.id] = a.headSha.slice(0, 7); ROUTE = allowed('case') ? 'case' : 'home'; }
    LIVE.deep = null;
    try { history.replaceState(null, '', '/#' + ROUTE); } catch (e) {}
  } else if (fresh) { ROUTE = 'home'; try { history.replaceState(null, '', '/#home'); } catch (e) {} }
  render();
  startPolling();
  if (fresh) toast(`Signed in as ${ME.name} · ${ME.role} (${roleLabel(ME)})`);
}

/* ---------- Keep the screens current while assessments run ---------- */
function stopPolling() { clearTimeout(LIVE.timer); LIVE.timer = null; }
async function refresh(force) {
  const changed = await loadLive();
  const busy = $('#drawer-root').innerHTML || (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName));
  if ((changed || force) && !busy) { const y = window.scrollY; render(); window.scrollTo(0, y); }
}
function startPolling() {
  stopPolling();
  const tick = async () => { if (document.querySelector('.app').hidden) return; await refresh(false); LIVE.timer = setTimeout(tick, anyRunning() ? 3000 : 15000); };
  LIVE.timer = setTimeout(tick, anyRunning() ? 3000 : 15000);
}

/* ---------- Add application: what an Admin gives PRCheck.live, each part tested before saving ---------- */
const WIZ_STEPS = [
  ['application', 'Application', 'Name it and give the key the policy repository uses for it.'],
  ['github', 'GitHub', 'The repository whose pull requests PRCheck.live assures, and the branch they merge into.'],
  ['jira', 'Jira', 'Where stories and acceptance criteria live. The PR title or branch names the issue.'],
  ['xray', 'Xray', "The team's test cases and their results for each commit. Shown as context; they never decide."],
  ['policies', 'Policy repository', 'The rules this application is assured against, owned by their authorities.'],
  ['verifiers', 'Verifiers repository', "PRCheck.live's own checks for this application, one per obligation."],
  ['environment', 'QE environment', 'Where each pull request commit is deployed. It must report its commit at /version.'],
  ['channels', 'Channels', 'What the application offers on QE. The functional and regression lanes test each channel you choose.'],
  ['automation', 'Assurance suites', 'Where the functional and regression scripts that decide live, the agent core that produces them, and the team\'s own automation to learn from.'],
  ['identities', 'Test identities', "The verifiers repository declares which logins it needs. You give only their values, stored encrypted."],
  ['review', 'Review and create', 'Everything is tested again on the server before it is saved.'],
];
const blankDraft = () => ({
  key: '', name: '',
  github: { repository: '', base_branch: 'main', adapter: 'org', token: '', path: '' },
  jira: { project: '', adapter: 'cloud', base_url: '', email: '', token: '', path: '' },
  xray: { adapter: 'cloud', base_url: 'https://xray.cloud.getxray.app', client_id: '', client_secret: '', path: 'team-results', wait_seconds: 600 },
  policies: { source: '', token: '' }, verifiers: { source: '', token: '' },
  environment: { name: 'qe', base_url: '', wait_for_commit_seconds: 900, log_path: '' },
  channels: { ui: { enabled: true, url: '', browsers: ['chromium'] }, api: { enabled: true, base_url: '', spec: '' }, mcp: { enabled: false, url: '', token: '' } },
  automation: { suites: { source: '', token: '' }, core: { adapter: 'frozen-suites', version: '', budget_seconds: 600, url: '', token: '' }, team: { source: '', token: '' }, imports: { path: '', wait_seconds: 120 } },
  identities: [],
});
function startWizard(draft, editing, secretsSet) {
  LIVE.wiz = { step: 0, draft: draft || blankDraft(), editing: editing || null, secretsSet: secretsSet || [], results: {}, busy: false, saved: null, saveErr: null };
  const D = LIVE.wiz.draft;
  ['github', 'jira', 'policies', 'verifiers'].forEach(k => { D[k] = D[k] || {}; D[k].token = ''; });
  D.xray = { adapter: 'junit', base_url: 'https://xray.cloud.getxray.app', client_id: '', path: '', ...D.xray, client_secret: '' };
  if (D.github.adapter === 'api') D.github.adapter = 'org';
  const B = blankDraft();
  D.channels = { ui: { ...B.channels.ui, ...((D.channels || {}).ui || {}) }, api: { ...B.channels.api, ...((D.channels || {}).api || {}) }, mcp: { ...B.channels.mcp, ...((D.channels || {}).mcp || {}), token: '' } };
  D.automation = { suites: { ...B.automation.suites, ...((D.automation || {}).suites || {}), token: '' }, core: { ...B.automation.core, ...((D.automation || {}).core || {}), token: '' }, team: { ...B.automation.team, ...((D.automation || {}).team || {}), token: '' }, imports: { ...B.automation.imports, ...((D.automation || {}).imports || {}) } };
  (LIVE.wiz.draft.identities || []).forEach(i => { i.value = ''; });
  go('onboard');
}
const wget = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
function wset(o, path, v) { const ks = path.split('.'); const last = ks.pop(); const t = ks.reduce((x, k) => (x[k] = x[k] || {}), o); t[last] = v; }
function wfield(label, path, o = {}) {
  const W = LIVE.wiz, v = wget(W.draft, path);
  const id = 'wf-' + path.replace(/\W/g, '-');
  const secretSet = o.secret && W.secretsSet.includes(o.secret);
  const input = o.options
    ? `<select id="${id}" data-wf="${path}" data-wf-redraw="1">${o.options.map(([val, txt]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(txt)}</option>`).join('')}</select>`
    : `<input id="${id}" data-wf="${path}" type="${o.type || 'text'}" value="${esc(v == null ? '' : v)}"${o.ph || secretSet ? ` placeholder="${esc(secretSet ? 'Stored · leave blank to keep' : o.ph)}"` : ''}${o.type === 'password' ? ' autocomplete="new-password"' : ' autocomplete="off" spellcheck="false"'}${o.disabled ? ' disabled' : ''}${o.num ? ' inputmode="numeric"' : ''}>`;
  return `<div class="field"><label for="${id}">${esc(label)}</label>${input}${o.help ? `<span class="small muted">${o.help}</span>` : ''}</div>`;
}
function wcheck(label, path, help) {
  const v = !!wget(LIVE.wiz.draft, path), id = 'wf-' + path.replace(/\W/g, '-');
  return `<label for="${id}" style="display:flex;gap:10px;align-items:flex-start;cursor:pointer"><input id="${id}" type="checkbox" data-wf-check="${path}"${v ? ' checked' : ''} style="margin-top:3px;width:auto"><span><b>${label}</b>${help ? `<span class="small muted" style="display:block">${help}</span>` : ''}</span></label>`;
}
function stepForm(key) {
  const W = LIVE.wiz, d = W.draft;
  switch (key) {
    case 'application': return wfield('Display name', 'name', { ph: 'VendorPay', help: 'What people call it. Shown on every screen and in PR comments.' })
      + wfield('Application key', 'key', { ph: 'vendorpay', disabled: !!W.editing, help: 'Must match the key in the policy repository\'s <span class="mono">catalog/components.yaml</span>. It cannot change later.' });
    case 'github': return wfield('Repository', 'github.repository', { ph: 'your-org/vendorpay-app', help: 'owner/name on GitHub.' })
      + wfield('Base branch', 'github.base_branch', { ph: 'main', help: 'Pull requests into this branch are assured. Make <span class="mono">prcheck/assurance</span> a required check on it.' })
      + wfield('Connect with', 'github.adapter', { options: [['org', 'Organisation connection (PRCheck.live GitHub App)'], ['token', 'Access token for this repository'], ['local-git', 'Local clone on the engine host (demo)']] })
      + (d.github.adapter === 'token' ? wfield('Access token', 'github.token', { type: 'password', secret: 'GITHUB_TOKEN', ph: 'github_pat_…', help: 'Fine-grained token for this repository only. Permissions: <b>Commit statuses</b> and <b>Pull requests</b> read and write, <b>Contents</b> read. Stored encrypted; never shown again.' })
        : d.github.adapter === 'org' ? `<div class="notice info" style="margin:0"><span>Uses the connection set up once for your GitHub organisation. Choose <b>Access token</b> if this repository is not covered by it.</span></div>`
        : wfield('Local clone path', 'github.path', { ph: '/home/prcheck/repos/vendorpay-app' }));
    case 'jira': return wfield('Project key', 'jira.project', { ph: 'VP' })
      + wfield('Connection', 'jira.adapter', { options: [['cloud', 'Jira Cloud (REST API)'], ['file', 'Issue files on the engine host (demo)']] })
      + (d.jira.adapter === 'cloud'
        ? wfield('Site URL', 'jira.base_url', { ph: 'https://yourcompany.atlassian.net' }) + wfield('Service account email', 'jira.email', { ph: 'prcheck@yourcompany.com' })
          + wfield('API token', 'jira.token', { type: 'password', secret: 'JIRA_TOKEN', ph: 'Atlassian API token', help: 'Read-only access to the project is enough. Stored encrypted; never shown again.' })
        : wfield('Issue folder', 'jira.path', { ph: 'fixtures/jira', help: 'One <span class="mono">&lt;KEY&gt;.json</span> per issue.' }));
    case 'xray': return wfield('Connect with', 'xray.adapter', { options: [['cloud', 'Xray Cloud (API key)'], ['junit', 'JUnit result files on the engine host (demo)']] })
      + (d.xray.adapter === 'cloud'
        ? wfield('Xray URL', 'xray.base_url', { ph: 'https://xray.cloud.getxray.app', help: 'Change only for a regional Xray instance.' })
          + wfield('Client ID', 'xray.client_id', { ph: 'From Xray: Global settings → API Keys' })
          + wfield('Client secret', 'xray.client_secret', { type: 'password', secret: 'XRAY_CLIENT_SECRET', ph: 'Client secret of that API key', help: 'Read access to the Jira project is enough. Stored encrypted; never shown again.' })
          + `<div class="notice info" style="margin:0"><span>The team's CI imports each commit's results as a Test Execution labelled <span class="mono">commit-&lt;sha&gt;</span>, for example <span class="mono">commit-684fa4f</span>. That is how PRCheck.live finds the run for a pull request.</span></div>`
        : wfield('Results folder', 'xray.path', { ph: 'team-results', help: 'The team CI writes <span class="mono">&lt;commit&gt;/junit.xml</span> here.' }))
      + wfield('Wait for results (seconds)', 'xray.wait_seconds', { num: 1, help: 'How long PRCheck.live waits for the team\'s results after QE runs the commit.' })
      + `<div class="notice info" style="margin:0"><span>The team's test cases and results are context. They never decide the disposition.</span></div>`;
    case 'policies': return wfield('Git URL or checkout path', 'policies.source', { ph: 'https://github.com/your-org/vendorpay-policies.git', help: 'PRCheck.live clones a URL and pulls <b>main</b> before every assessment.' })
      + wfield('Access token (private repositories)', 'policies.token', { type: 'password', secret: 'POLICIES_GIT_TOKEN', ph: 'Optional · read-only', help: 'Read-only. Stored encrypted.' });
    case 'verifiers': return wfield('Git URL or checkout path', 'verifiers.source', { ph: 'https://github.com/your-org/prcheck-verifiers.git', help: 'Each check is named <span class="mono">Vn/check</span>, as the policy obligations reference it.' })
      + wfield('Access token (private repositories)', 'verifiers.token', { type: 'password', secret: 'VERIFIERS_GIT_TOKEN', ph: 'Optional · read-only', help: 'Read-only. Stored encrypted.' });
    case 'environment': return wfield('Environment name', 'environment.name', { ph: 'qe' })
      + wfield('Base URL', 'environment.base_url', { ph: 'https://qe.vendorpay.internal', help: 'PRCheck.live calls <span class="mono">/version</span> and verifies only when it reports the pull request\'s commit.' })
      + wfield('Wait for deploy (seconds)', 'environment.wait_for_commit_seconds', { num: 1, help: 'If QE never reports the commit, the result is INDETERMINATE, never READY.' })
      + wfield('Application log file', 'environment.log_path', { ph: '/var/log/vendorpay/app.log', help: 'Optional. Lets the verifiers check that logs never hold sensitive data.' });
    case 'channels': {
      const c = d.channels, br = c.ui.browsers || [];
      const box = (inner) => `<div style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px">${inner}</div>`;
      return box(wcheck('Web UI', 'channels.ui.enabled', 'Screens and journeys, driven in real browsers.')
          + (c.ui.enabled ? wfield('UI address on QE', 'channels.ui.url', { ph: d.environment.base_url || 'https://qe.vendorpay.internal', help: 'Leave blank to use the QE environment address.' })
            + `<fieldset style="border:0;padding:0;margin:0"><legend class="small" style="font-weight:600;margin-bottom:6px">Browsers</legend><div style="display:flex;gap:16px;flex-wrap:wrap">${['chromium', 'firefox', 'webkit'].map(b => `<label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-wf-list="channels.ui.browsers" value="${b}"${br.includes(b) ? ' checked' : ''} style="width:auto"> ${b === 'chromium' ? 'Chromium (Chrome, Edge)' : b === 'firefox' ? 'Firefox' : 'WebKit (Safari)'}</label>`).join('')}</div></fieldset>` : ''))
        + box(wcheck('API', 'channels.api.enabled', 'REST or GraphQL endpoints, called directly.')
          + (c.api.enabled ? wfield('API base URL on QE', 'channels.api.base_url', { ph: (d.environment.base_url || 'https://qe.vendorpay.internal') + '/api', help: 'Leave blank to use the QE environment address.' })
            + wfield('API specification', 'channels.api.spec', { ph: 'https://qe.vendorpay.internal/openapi.json', help: 'Optional. An OpenAPI (Swagger) URL or file. The agents design API checks from every endpoint it lists.' }) : ''))
        + box(wcheck('MCP server', 'channels.mcp.enabled', 'Tools the application exposes to AI agents over the Model Context Protocol.')
          + (c.mcp.enabled ? wfield('MCP endpoint on QE', 'channels.mcp.url', { ph: 'https://qe.vendorpay.internal/mcp', help: 'Streamable HTTP transport. PRCheck.live connects, initialises and lists the tools.' })
            + wfield('Access token', 'channels.mcp.token', { type: 'password', secret: 'MCP_TOKEN', ph: 'Optional · bearer token', help: 'For a QE test account, never production. Stored encrypted; never shown again.' }) : ''));
    }
    case 'automation': {
      const a = d.automation;
      return `<div class="notice info" style="margin:0"><span>The scripts that decide the verdict live in a repository <b>PRCheck.live owns</b>. The team cannot push to it, so a team cannot weaken the checks on its own change. The team's automation repository is optional and read-only.</span></div>
        <h3 style="margin:4px 0 0;font-size:14px">Assurance suites repository</h3>`
        + wfield('Git URL or checkout path', 'automation.suites.source', { ph: 'https://github.com/your-org/prcheck-suites-vendorpay.git', help: 'Functional and regression suites per story, generated by the agent core and approved by an Assurance Lead: <span class="mono">functional/suites/&lt;story&gt;.yaml</span>. May be the verifiers repository.' })
        + wfield('Access token (private repositories)', 'automation.suites.token', { type: 'password', secret: 'SUITES_GIT_TOKEN', ph: 'Optional · read-only', help: 'Read-only for running. Stored encrypted.' })
        + `<h3 style="margin:8px 0 0;font-size:14px">Agent core</h3>`
        + wfield('Produced by', 'automation.core.adapter', { options: [['agent-core', 'myDiya agent core (generates verifiers and suites, impact analysis)'], ['frozen-suites', 'Not connected: suites delivered to the repository by hand']] })
        + (a.core.adapter === 'agent-core' ? wfield('Agent core address', 'automation.core.url', { ph: 'https://agent-core.ascendqe.internal', help: 'Speaks <span class="mono">prcheck.agent-core/v1</span>. PRCheck.live sends it missions; it never sees evidence or verdicts.' })
          + wfield('Access token', 'automation.core.token', { type: 'password', secret: 'AGENT_CORE_TOKEN', ph: 'Bearer token for this application', help: 'Stored encrypted; never shown again.' }) : '')
        + wfield('Agent core version', 'automation.core.version', { ph: '0.1.0', help: 'Optional. Pin the version so a new release cannot change verdicts until you upgrade.' })
        + wfield('Time budget per pull request (seconds)', 'automation.core.budget_seconds', { num: 1, help: 'If the suites do not finish in time, the criteria are NOT ASSESSED and the change cannot be READY.' })
        + `<h3 style="margin:8px 0 0;font-size:14px">Team automation repository <span class="small muted" style="font-weight:400">optional · read-only</span></h3>`
        + wfield('Git URL or checkout path', 'automation.team.source', { ph: 'https://github.com/your-org/vendorpay-tests.git', help: 'The agents read its framework, page objects, API clients and tags to write better suites. PRCheck.live never pushes to it, and its results never decide.' })
        + wfield('Access token (private repositories)', 'automation.team.token', { type: 'password', secret: 'TEAM_GIT_TOKEN', ph: 'Optional · read-only', help: 'Read-only. Stored encrypted.' })
        + `<h3 style="margin:8px 0 0;font-size:14px">Results from other tools</h3>`
        + wfield('Results folder', 'automation.imports.path', { ph: '/srv/prcheck/imports/vendorpay', help: 'The profile lists the results it requires (security scan, dependency audit, performance). The team\'s CI writes each one per commit as <span class="mono">&lt;commit&gt;/&lt;id&gt;.json</span>.' })
        + wfield('Wait for results (seconds)', 'automation.imports.wait_seconds', { num: 1, help: 'A result that has not arrived by then is pending: the change cannot be READY.' });
    }
    case 'identities': {
      const needed = wizIdentities();
      if (!needed) return `<div class="notice amber" style="margin:0"><span>Test the <b>Verifiers repository</b> step first. The verifiers declare which logins they need in <span class="mono">identities.yaml</span>.</span><button class="btn" data-action="wiz-go" data-id="5">Go to Verifiers</button></div>`;
      if (!needed.length) return '<p class="small" style="margin:0">The verifiers need no logins.</p>';
      return `<p class="small" style="margin:0">These logins are declared by the verifiers repository (<span class="mono">identities.yaml</span>). Give PRCheck.live its own account for each role, never the team's test accounts.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Variable</th><th>Role · used for</th><th style="width:38%">Value</th></tr></thead><tbody>
        ${needed.map(n => { const i = d.identities.findIndex(x => x.name === n.name); const id = 'wf-identities-' + i + '-value'; const stored = W.secretsSet.includes(n.name);
          return `<tr><td class="mono small">${esc(n.name)}</td><td class="small"><b>${esc(n.role || '—')}</b>${n.purpose ? `<div class="muted">${esc(n.purpose)}</div>` : ''}</td>
            <td><label class="sr-only" for="${id}">${esc(n.name)}</label><input id="${id}" data-wf="identities.${i}.value" type="${n.secret ? 'password' : 'text'}" value="${esc(d.identities[i].value || '')}" placeholder="${esc(stored ? 'Stored · leave blank to keep' : n.secret ? 'secret' : 'login')}" autocomplete="${n.secret ? 'new-password' : 'off'}" spellcheck="false" style="border:1px solid var(--line);border-radius:8px;padding:7px 9px;width:100%"></td></tr>`; }).join('')}
        </tbody></table></div>`;
    }
    case 'review': return reviewPanel();
  }
  return '';
}
const ICON = { pass: ['✓', 'var(--green-text)'], warn: ['!', 'var(--amber-text)'], fail: ['✕', 'var(--red-text)'] };
function resultBox(res) {
  if (!res) return '';
  const head = { pass: 'All checks passed', warn: 'Passed with warnings', fail: 'Fix the failed checks' }[res.status];
  return `<div role="status" style="border:1px solid var(--${res.status === 'pass' ? 'green' : res.status === 'warn' ? 'amber' : 'red'}-line);background:var(--${res.status === 'pass' ? 'green' : res.status === 'warn' ? 'amber' : 'red'}-tint);border-radius:10px;padding:12px 14px">
    <b style="color:${ICON[res.status][1]}">${head}</b>
    <ul style="list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px">${res.checks.map(c => `<li class="small" style="display:grid;grid-template-columns:18px minmax(0,1fr);gap:6px"><b aria-hidden="true" style="color:${ICON[c.status][1]}">${ICON[c.status][0]}</b><span><b>${esc(c.label)}</b>${c.detail ? ` · <span style="overflow-wrap:anywhere">${esc(c.detail)}</span>` : ''}</span></li>`).join('')}</ul></div>`;
}
function reviewPanel() {
  const W = LIVE.wiz, d = W.draft;
  if (W.saved) return savedPanel();
  const row = (k, label, v) => { const r = W.results[k]; const st = r ? r.status : null; return `<div>${esc(label)}</div><div>${v}${st ? ` <b style="color:${ICON[st][1]}" title="${st}">${ICON[st][0]}</b>` : ' <span class="small muted">not tested</span>'}</div>`; };
  const secretLabel = (val, name) => val ? 'new value entered' : (W.secretsSet.includes(name) ? 'stored' : 'none');
  return `<div class="kv small" style="grid-template-columns:170px minmax(0,1fr)">
    ${row('application', 'Application', `<b>${esc(d.name)}</b> <span class="mono">(${esc(d.key)})</span>`)}
    ${row('github', 'GitHub', `<span class="mono">${esc(d.github.repository)}</span> → ${esc(d.github.base_branch)} · ${d.github.adapter === 'token' ? `access token ${secretLabel(d.github.token, 'GITHUB_TOKEN')}` : d.github.adapter === 'local-git' ? 'local clone' : 'organisation connection'}`)}
    ${row('jira', 'Jira', `${esc(d.jira.project)} · ${d.jira.adapter === 'cloud' ? `${esc(d.jira.base_url)} as ${esc(d.jira.email)} · token ${secretLabel(d.jira.token, 'JIRA_TOKEN')}` : 'issue files'}`)}
    ${row('xray', 'Xray', `${d.xray.adapter === 'cloud' ? `Xray Cloud · client <span class="mono">${esc(d.xray.client_id)}</span> · secret ${secretLabel(d.xray.client_secret, 'XRAY_CLIENT_SECRET')}` : `<span class="mono">${esc(d.xray.path)}</span>`} · wait ${esc(d.xray.wait_seconds)} s`)}
    ${row('policies', 'Policy repository', `<span class="mono">${esc(d.policies.source)}</span>`)}
    ${row('verifiers', 'Verifiers', `<span class="mono">${esc(d.verifiers.source)}</span>`)}
    ${row('environment', 'QE environment', `<span class="mono">${esc(d.environment.base_url)}</span> · wait ${esc(d.environment.wait_for_commit_seconds)} s`)}
    ${row('channels', 'Channels', [d.channels.ui.enabled ? `UI (${(d.channels.ui.browsers || []).join(', ')})` : '', d.channels.api.enabled ? `API${d.channels.api.spec ? ' with specification' : ''}` : '', d.channels.mcp.enabled ? `MCP <span class="mono">${esc(d.channels.mcp.url)}</span>` : ''].filter(Boolean).join(' · ') || 'none')}
    ${row('automation', 'Assurance suites', `${d.automation.suites.source ? `<span class="mono">${esc(d.automation.suites.source)}</span>` : 'none'} · ${d.automation.core.adapter === 'agent-core' ? 'myDiya agent core' : 'approved suites'}${d.automation.team.source ? ` · team repository <span class="mono">${esc(d.automation.team.source)}</span> (read-only)` : ''}${d.automation.imports.path ? ` · tool results <span class="mono">${esc(d.automation.imports.path)}</span>` : ''}`)}
    ${row('identities', 'Test identities', d.identities.length ? d.identities.map(i => `<span class="mono">${esc(i.name)}</span>`).join(', ') : 'built-in defaults')}
  </div>
  ${W.saveErr ? `<div class="notice red" style="margin:0"><span>${esc(W.saveErr)}</span></div>` : ''}
  <p class="small muted" style="margin:0">Creating it records who did it in the platform audit log. Credentials are stored encrypted and never shown again.</p>`;
}
function savedPanel() {
  const W = LIVE.wiz, g = W.saved.github;
  const copy = (t) => `<button class="copy" data-action="copy" data-text="${esc(t)}">Copy</button>`;
  return `<div class="notice" style="margin:0;background:var(--green-tint);border-color:var(--green-line)"><span><b style="color:var(--green-text)">${esc(W.draft.name)} is ${W.editing ? 'updated' : 'onboarded'}.</b> The next pull request on <span class="mono">${esc(g.repository)}</span> starts an assessment.</span></div>
    <h3 style="margin:4px 0 0;font-size:14px">On GitHub (once, unless the PRCheck.live GitHub App does it for you)</h3>
    <div class="kv small" style="grid-template-columns:150px minmax(0,1fr)">
      <div>Webhook payload URL</div><div><span class="mono">${esc(g.webhookUrl)}</span> ${copy(g.webhookUrl)}</div>
      <div>Content type</div><div class="mono">${esc(g.contentType)}</div>
      <div>Secret</div><div>The engine's <span class="mono">WEBHOOK_SECRET</span></div>
      <div>Events</div><div>Pull requests</div>
      <div>Branch protection</div><div>On <span class="mono">${esc(g.base)}</span>, require the status check <span class="mono">${esc(g.requiredCheck)}</span> ${copy(g.requiredCheck)}</div>
    </div>
    <p class="small muted" style="margin:0">In the Linux demo kit, <span class="mono">configure-github.sh</span> sets both.</p>`;
}
function viewOnboard() {
  const W = LIVE.wiz;
  if (!W) { startWizardLater(); return '<div class="ph"><div><h1>Add application</h1></div></div>'; }
  const [key, title, sub] = WIZ_STEPS[W.step];
  const res = W.results[key];
  const steps = WIZ_STEPS.map(([k, t], i) => { const r = W.results[k]; const st = r ? r.status : null;
    return `<li><button class="wiz-step${i === W.step ? ' on' : ''}" data-action="wiz-go" data-id="${i}"${i === W.step ? ' aria-current="step"' : ''}><span class="n" style="${st ? `background:${ICON[st][1]};border-color:${ICON[st][1]};color:#fff` : ''}">${st ? ICON[st][0] : i + 1}</span>${esc(t)}</button></li>`; }).join('');
  const isReview = key === 'review', saved = !!W.saved;
  const canNext = res && res.status !== 'fail';
  const actions = saved ? `<button class="btn primary" data-action="wiz-done">Open Integrations</button>`
    : isReview ? `<button class="btn" data-action="wiz-back">Back</button><button class="btn primary" data-action="wiz-save"${W.busy ? ' disabled' : ''}>${W.busy ? '<span class="st run sm" aria-hidden="true"></span>Testing everything…' : W.editing ? 'Save changes' : 'Create application'}</button>`
    : `${W.step ? '<button class="btn" data-action="wiz-back">Back</button>' : ''}<button class="btn" data-action="wiz-test"${W.busy ? ' disabled' : ''}>${W.busy ? '<span class="st run sm" aria-hidden="true"></span>Testing…' : 'Test connection'}</button><button class="btn primary" data-action="wiz-next"${canNext ? '' : ' disabled title="Test this step first"'}>Next</button>`;
  return `<div class="ph"><div><h1>${W.editing ? `Edit ${esc(W.draft.name)}` : 'Add application'}</h1><p class="sub">Connect one application to PRCheck.live. Each connection is tested for real before it is saved.</p></div><div class="acts"><button class="btn" data-action="wiz-cancel">${saved ? 'Close' : 'Cancel'}</button></div></div>
    <div class="wiz">
      <nav aria-label="Steps"><ol class="wiz-steps">${steps}</ol></nav>
      <section class="card" aria-labelledby="wiz-h" style="display:flex;flex-direction:column;gap:14px;min-width:0">
        <div><p class="small muted" style="margin:0">Step ${W.step + 1} of ${WIZ_STEPS.length}</p><h2 id="wiz-h" style="margin:2px 0 4px">${esc(title)}</h2><p class="small muted" style="margin:0">${esc(sub)}</p></div>
        <form id="wiz-form" style="display:flex;flex-direction:column;gap:12px" onsubmit="return false">${stepForm(key)}</form>
        <div id="wiz-res">${isReview ? '' : resultBox(res)}</div>
        <div class="btnrow" style="justify-content:flex-end">${actions}</div>
      </section>
    </div>`;
}
function startWizardLater() { setTimeout(() => { if (!LIVE.wiz && route() === 'onboard') startWizard(); }, 0); }
async function wizTest() {
  const W = LIVE.wiz, key = WIZ_STEPS[W.step][0];
  W.busy = true; render();
  const r = await api('/api/ui/applications/test', { method: 'POST', body: { step: key, draft: W.draft, editing: W.editing } });
  W.busy = false;
  W.results[key] = r.ok ? r.data : { step: key, status: 'fail', checks: [{ label: 'Test', status: 'fail', detail: r.data.message || `HTTP ${r.status}` }] };
  // The verifiers tell us which login variables they read: offer them on the identities step.
  // The verifiers declare the logins they need: the identities step lists exactly those.
  if ((key === 'verifiers' || key === 'automation' || key === 'identities') && r.ok && r.data.found && r.data.found.identities) syncIdentities(r.data.found.identities);
  render();
  const box = $('#wiz-res'); if (box) box.scrollIntoView({ block: 'nearest' });
}
function wizIdentities() {
  const W = LIVE.wiz;
  const f = (W.results.identities && W.results.identities.found && W.results.identities.found.identities) || (W.results.automation && W.results.automation.found && W.results.automation.found.identities) || (W.results.verifiers && W.results.verifiers.found && W.results.verifiers.found.identities) || (W.results.identities && W.results.identities.found && W.results.identities.found.identities) || W.idMeta;
  if (f) return f;
  return W.editing && W.draft.identities.length ? W.draft.identities.map(i => ({ name: i.name, secret: /PASS|TOKEN|SECRET/.test(i.name) })) : null;
}
function syncIdentities(list) {
  const W = LIVE.wiz, old = W.draft.identities;
  W.idMeta = list;
  W.draft.identities = list.map(n => ({ name: n.name, value: (old.find(o => o.name === n.name) || {}).value || '' }));
}
async function wizSave() {
  const W = LIVE.wiz;
  W.busy = true; W.saveErr = null; render();
  const r = await api(W.editing ? `/api/ui/applications/${encodeURIComponent(W.editing)}` : '/api/ui/applications', { method: W.editing ? 'PUT' : 'POST', body: { draft: W.draft } });
  W.busy = false;
  if (r.ok) { W.saved = r.data; (r.data.results || []).forEach(x => { W.results[x.step] = x; }); LIVE.platform = null; LIVE.apps = null; toast(`${W.draft.name} ${W.editing ? 'updated' : 'onboarded'}.`); }
  else if (r.status === 422) {
    (r.data.results || []).forEach(x => { W.results[x.step] = x; });
    const bad = (r.data.results || []).filter(x => x.status === 'fail').map(x => WIZ_STEPS.find(s => s[0] === x.step)[1]);
    W.saveErr = `Not saved. These steps fail now: ${bad.join(', ')}. Open them to see why.`;
  } else W.saveErr = r.data.message || `Not saved (HTTP ${r.status}).`;
  render();
}
FY_GO['add-app'] = () => startWizard();
document.addEventListener('input', e => {
  const el = e.target; if (!el.dataset || !el.dataset.wf || !LIVE.wiz) return;
  e.stopImmediatePropagation();
  const num = el.getAttribute('inputmode') === 'numeric';
  wset(LIVE.wiz.draft, el.dataset.wf, num ? (el.value === '' ? '' : Number(el.value)) : el.value);
  const key = WIZ_STEPS[LIVE.wiz.step][0];
  if (LIVE.wiz.results[key]) { delete LIVE.wiz.results[key]; const box = $('#wiz-res'); if (box) box.innerHTML = ''; const nx = $('[data-action="wiz-next"]'); if (nx) { nx.disabled = true; nx.title = 'Test this step first'; } render_steps(); }
}, true);
document.addEventListener('change', e => {
  const el = e.target; if (!el.dataset || !LIVE.wiz) return;
  if (el.dataset.wfCheck || el.dataset.wfList) {
    e.stopImmediatePropagation();
    if (el.dataset.wfCheck) wset(LIVE.wiz.draft, el.dataset.wfCheck, el.checked);
    else { const cur = wget(LIVE.wiz.draft, el.dataset.wfList) || []; wset(LIVE.wiz.draft, el.dataset.wfList, el.checked ? [...new Set([...cur, el.value])] : cur.filter(x => x !== el.value)); }
    delete LIVE.wiz.results[WIZ_STEPS[LIVE.wiz.step][0]]; render(); return;
  }
  if (!el.dataset.wfRedraw) return;
  e.stopImmediatePropagation(); wset(LIVE.wiz.draft, el.dataset.wf, el.value); delete LIVE.wiz.results[WIZ_STEPS[LIVE.wiz.step][0]]; render();
}, true);
function render_steps() {
  const W = LIVE.wiz; document.querySelectorAll('.wiz-step').forEach((b, i) => { const r = W.results[WIZ_STEPS[i][0]]; const n = b.querySelector('.n'); if (!r && n) { n.removeAttribute('style'); n.textContent = i + 1; } });
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]'); if (!t) return;
  const a = t.dataset.action, id = t.dataset.id;
  const W = LIVE.wiz;
  const stop = () => { e.stopImmediatePropagation(); e.preventDefault(); };
  switch (a) {
    case 'app-add': stop(); startWizard(); break;
    case 'app-sel': stop(); LIVE.appSel = id; render(); break;
    case 'app-edit': stop(); api(`/api/ui/applications/${encodeURIComponent(id)}`).then(r => { if (r.ok) startWizard(r.data.draft, id, r.data.secretsSet); else toast(r.data.message || 'Could not open it.'); }); break;
    case 'app-status': stop(); { const app = (LIVE.apps || []).find(x => x.key === id); const next = app && app.status === 'paused' ? 'active' : 'paused';
      api(`/api/ui/applications/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status: next } }).then(r => { toast(r.ok ? `${app.name} ${next === 'paused' ? 'paused: its pull requests are ignored until resumed' : 'resumed'}.` : (r.data.message || 'Failed.')); LIVE.platform = null; LIVE.apps = null; render(); }); } break;
    case 'wiz-test': stop(); if (W && !W.busy) wizTest(); break;
    case 'wiz-next': stop(); if (W && W.results[WIZ_STEPS[W.step][0]] && W.results[WIZ_STEPS[W.step][0]].status !== 'fail') { W.step++; render(); } break;
    case 'wiz-back': stop(); if (W && W.step) { W.step--; render(); } break;
    case 'wiz-go': stop(); if (W && !W.saved) { W.step = Number(id); render(); } break;
    case 'wiz-save': stop(); if (W && !W.busy) wizSave(); break;
    case 'wiz-cancel': case 'wiz-done': stop(); LIVE.wiz = null; LIVE.platform = null; LIVE.apps = null; go('integrations'); break;
  }
}, true);
if (!VALID.includes('onboard')) VALID.push('onboard');
PAGE_NAMES.onboard = 'Add application';
NAV_FOR.onboard = 'integrations';
/* Wizard styles (.wiz, .wiz-step) live in ui/prototype.html. */

/* ---------- Identities beyond the prototype's six: one per rule-owning authority ---------- */
if (!ACCOUNTS.some(a => a.email === 'v.bose@prcheck.demo')) ACCOUNTS.splice(ACCOUNTS.length - 1, 0,
  { email: 'v.bose@prcheck.demo', short: 'V. Bose', name: 'Vikram Bose', role: 'Compliance Officer', tagRole: 'Compliance Officer', sysRole: 'Viewer', auth: ['Compliance'], initials: 'VB', job: 'Owns audit-trail rules and compliance exceptions' },
  { email: 'a.pillai@prcheck.demo', short: 'A. Pillai', name: 'Arjun Pillai', role: 'Platform Engineering Lead', tagRole: 'Platform Lead', sysRole: 'Contributor', auth: ['Platform'], initials: 'AP', job: 'Owns build, deploy and environment rules' });
/* Authority holders review their area's rules on every application, so they are not scoped to one. */
function access(a) {
  if ((!a || (ME && a.email === ME.email)) && LIVE.access) return LIVE.access;
  a = a || ME;
  if (a.sysRole === 'Admin') return { routes: ['home', 'integrations', 'onboard', 'profiles', 'org-settings'], scope: 'none' };
  if (a.sysRole === 'Assurance Lead') return { routes: ['home', ...ALL_CHANGE, 'integrations', 'profiles', 'org-settings'], scope: 'all' };
  if (a.sysRole === 'Contributor') return { routes: ['home', ...ALL_CHANGE, 'org-settings'], scope: a.auth.length ? 'all' : 'VendorPay' };
  return { routes: ['home', ...ALL_CHANGE, 'org-settings'], scope: 'all' };
}
function homeLabel(a) {
  a = a || ME;
  if (a.sysRole === 'Admin') return 'Overview';
  if (a.auth.length) return { Finance: 'Decisions', Security: 'Security review', Compliance: 'Compliance review', Platform: 'Platform review' }[a.auth[0]] || 'My rules';
  if (a.sysRole === 'Assurance Lead') return 'My queue';
  if (a.sysRole === 'Contributor') return 'My changes';
  return 'Release readiness';
}

/* ---------- Boot ---------- */
(() => { const st = document.createElement('style'); st.textContent = '.tl .e > div, .kv > div, .trace .rows span { overflow-wrap: anywhere; min-width: 0; }'; document.head.appendChild(st); })();
(async () => {
  S.flow.on = true;               // the guided demo flow is for the simulated prototype only
  const deep = location.pathname.match(/^\/assessments\/([^/]+)/);
  LIVE.deep = deep ? decodeURIComponent(deep[1]) : null;
  const r = await api('/api/ui/me', { allow401: true });
  if (r.ok) await enterLive(r.data.account, false, r.data.access);
  else showLogin(LIVE.deep ? { t: 'info', m: `Sign in to open assessment ${LIVE.deep}.` } : null);
})();
