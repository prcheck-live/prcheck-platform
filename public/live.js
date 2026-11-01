/* QIVVRA live layer.
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

const LIVE = { changes: [], byId: {}, rev: {}, caseRev: {}, platform: null, users: null, sig: '', timer: null, deep: null, runPoll: null };

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
      verifier: { id: vid, name: `${vid} ${cat.name || ''}`.trim(), ver: x.evidence.verifierCommit ? `qivvra-verifiers@${x.evidence.verifierCommit}` : '', label: `${(cat.name || vid).toLowerCase()} verifier` },
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
    else if (state === 'NOT ASSESSED') { gapType = envConfirmed === false ? 'Operational' : 'Pending'; gap = envConfirmed === false ? 'QE not running this commit' : 'Not yet evaluated'; }
    if (a.integrity.evidence === 'mismatch' && exec) { state = 'INSUFFICIENT'; gapType = 'Integrity'; gap = 'Evidence integrity mismatch'; integrityFail = true; }
    const exception = (pol.exceptions || []).find(x => x.policy === r.policy_id && (x.obligations || []).includes(r.obligation_id));
    return {
      id: r.obligation_id, title: r.statement.replace(/\.$/, ''), statement: r.statement,
      authority: { cls: 'Authoritative', id: r.policy_id, name: p.title || r.policy_id, owner: p.owner || '', prov: `vendorpay-policies · ${p.file || r.policy_id} v${r.policy_version}${p.digest ? ' · ' + shortD(p.digest) : ''}` },
      crit: SEV[r.severity] || 'High', blocking: true, strength: ['SUPPORTED', 'VIOLATED'].includes(state) && !integrityFail ? 'Strong' : 'Missing',
      state, gap, gapType, plain, integrityFail, exec,
      verifier: { id: vid, name: `${vid} ${cat.name || ''}`.trim(), ver: verCommit ? `qivvra-verifiers@${verCommit}` : '', label: `${(cat.name || vid).toLowerCase()} verifier` },
      proof: ((cat.checks || {})[r.evidence_check.split('/')[1]] || 'Independent behavioural evidence for this obligation').replace(/\.$/, '') + '.',
      assumptions: `QE (${env.baseUrl}) runs commit ${a.headSha.slice(0, 7)}, confirmed at /version before and after verification. Verifiers act through VendorPay's public API and UI with QIVVRA's own test identities.`,
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
    riskRationale: `${risk} under the ${pol.profile} profile. The change touches ${comps.join(', ') || 'no mapped component'}, so ${pol.policies.filter(p => p.severity === 'critical').length} critical policies apply. QIVVRA does not compute a risk score; materiality comes from the policies.`,
    business: null,
    rev: { key: cur.key, hash: cur.key, isLatest: cur.key === latestRev.key, latestHash: latestRev.key, latestKey: latestRev.key },
    revisions: revs.map(r => ({ key: r.key, hash: r.key, received: true })),
    run: inProg ? null : { id: a.id, at: fmt(at) }, assessed: !inProg && a.status === 'done', inProgress: inProg,
    cutoff: inProg ? '—' : fmt(at), obls, retired: [], updated: new Date(a.createdAt).getTime(),
  };
  finishVM(vm);
  // The engine's verdict is the verdict: the UI never re-decides it.
  const code = inProg ? 'NONE' : a.status === 'failed' ? 'INDETERMINATE' : (DCODE[a.disposition] || 'NONE');
  const violated = obls.filter(o => o.state === 'VIOLATED'), open = obls.filter(o => o.state !== 'SUPPORTED');
  const reason = inProg ? `Assessment ${a.id} is ${STATUS_WORD[a.status] || a.status}.`
    : code === 'NOT_READY' && violated.length ? 'Blocked: ' + violated.map(plainViolation).join(' ')
    : code === 'READY' ? `All ${obls.length} material obligations are supported by evidence bound to revision ${cur.key}. No unresolved blocking condition exists within the assurance boundary.`
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
  if (!can('run') && ME.sysRole === 'Contributor') return `<button class="btn" data-action="request-rerun">Request re-run</button>`;
  return gate(can('run'), `<button class="btn primary" data-action="run">Re-run assurance</button>`, NEEDS.run);
}

function emptyChanges() {
  return `<div class="card" style="max-width:680px;margin:40px auto;text-align:center;padding:36px 32px"><h1 style="font-size:22px;margin:0 0 8px;color:var(--navy)">No pull requests assessed yet</h1>
    <p class="muted" style="margin:0">QIVVRA starts an assessment when a pull request is opened or updated on an onboarded repository${access().scope !== 'all' ? ` in ${esc(access().scope)}` : ''}. It appears here within seconds.</p></div>`;
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
  const fn = { home: viewHome, command: viewCommand, change: viewChange, revisions: viewRevisions, graph: viewGraph, obligations: viewObligations, gaps: viewGaps, evidence: viewEvidence, case: viewCase, integrations: viewIntegrations, profiles: viewProfiles, 'org-settings': viewSettings }[r];
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
function viewGaps() {
  const vm = curVM();
  const tones = { 'Violation': 't-red', 'Insufficient': 't-amber', 'Conflicted': 't-purple', 'Unknown impact': 't-neutral', 'Stale evidence': 't-stale' };
  const cards = vm.gaps.map(g => {
    const o = g.o;
    let actions = '';
    if (o) {
      actions += `<button class="btn" data-action="open-evidence" data-id="${esc(o.id)}">Inspect evidence</button>`;
      if (g.type === 'Violation') actions += `<span class="small muted">Finding posted to PR #${vm.change.prNumber} by the <span class="mono">qivvra/assurance</span> check. The producer fixes it and pushes a new revision.</span>`;
      if (['Operational', 'Integrity', 'Pending'].includes(o.gapType) && vm.rev.isLatest) actions += gate(can('run'), `<button class="btn primary" data-action="run">Re-run assurance on ${vm.rev.hash}</button>`, NEEDS.run);
      if (o.state === 'INSUFFICIENT' && !o.exception) actions += o.crit === 'Critical' ? '<span class="small muted">Critical obligations cannot be accepted as exceptions (profile rule).</span>'
        : gate(can('run'), `<button class="btn" data-action="exception" data-id="${esc(o.id)}">Propose exception…</button>`, NEEDS.run);
      if (o.state === 'VIOLATED') actions += '<span class="small muted">Violations cannot be waived by an exception (profile rule).</span>';
    }
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
        ${owner}
        <div class="btnrow">${actions}</div></div></article>`;
  }).join('');
  return `${staleBanner(vm)}
    <div class="ph"><div><h1>${esc(vm.id)}<span class="sep">·</span>Gaps &amp; uncertainty</h1><p class="sub">Every gap says what would resolve it. Uncertainty is listed, never treated as a pass.</p></div>
      <div class="acts">${dispBadge(vm.disp.code, { lg: true })}${runButton(vm)}</div></div>
    <div class="filters"><nav class="seg" aria-label="Obligation views"><a href="#obligations">Obligations</a><a href="#gaps" class="on" aria-current="page">Gaps &amp; uncertainty (${vm.gaps.length})</a></nav></div>
    <div class="gaps">${cards || `<div class="card"><div class="empty"><b>No unresolved gaps identified within current scope.</b>This does not mean the change carries no risk. It means no gap was found inside the assurance boundary.</div></div>`}</div>`;
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
  const proof = [['Frozen context', a.digests.context, a.integrity.context], ['Verifier evidence', a.digests.evidence, a.integrity.evidence], ['PR report', a.digests.report, a.digests.report ? 'sealed' : 'missing']];
  return `${staleBanner(base)}
    <div class="ph"><div><h1>Change Assurance Case</h1><p class="sub small">${esc(vm.id)} &nbsp;·&nbsp; PR #${ch.prNumber} &nbsp;·&nbsp; Revision <span class="mono">${vm.rev.hash}</span> &nbsp;·&nbsp; ${esc(a.id)}</p></div><div class="acts">${dispBadge(vm.disp.code, { lg: true })}</div></div>
    <div class="grid2 grid-case">
    <div>
    <div class="card" style="margin-bottom:20px"><span class="lbl">Disposition rationale</span><div style="font-size:18px;font-weight:700;color:var(--navy);margin:4px 0 6px;text-wrap:balance">${esc(caseHeadline(vm))}</div>
      <p class="small muted" style="margin:0">${esc(vm.disp.reason)} This disposition applies only to the declared assurance boundary and exact evaluated revision.</p>
      ${team ? `<p class="small" style="margin:10px 0 0"><b>Team tests on this commit:</b> ${team.passed}/${team.total} passed. They are context: QIVVRA's verdict comes only from its own verifiers and the policy repository.</p>` : ''}</div>
    <div class="tiles fit">${tiles.map(([l, n, c]) => `<div class="tile static"><b class="num" style="color:${col[c]}">${n}</b><span>${l}</span></div>`).join('')}</div>
    ${chain}
    <div class="grid-even" style="margin-bottom:20px">
      <div class="card"><h2>Material findings</h2>${material.length ? `<div style="display:flex;flex-direction:column;gap:12px">${material.map(o => `<div style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start"><div>${stateBadge(o.state)}</div><div><span class="oid">${esc(o.id)}</span><b>${esc(o.title)}</b><div class="small muted">${esc(o.state === 'VIOLATED' ? plainViolation(o) : o.gap)} · owner ${esc(o.authority.owner)}</div></div></div>`).join('')}</div>` : '<p class="muted" style="margin:0">No violated, insufficient, conflicted or unassessed obligations within the boundary.</p>'}
        <span class="lbl" style="margin-top:18px">Residual uncertainty</span><p style="margin:0">${vm.gaps.filter(g => g.type === 'Unknown impact').map(g => esc(g.cause)).join('<br>') || 'None identified within current scope.'}</p></div>
      ${boundaryPanel(vm)}
    </div>
    <div class="grid-even">
      <div class="card"><h2>Proof</h2><div class="kv small">${proof.map(([l, d, i]) => `<div>${l}</div><div>${d ? `<a class="mono" href="/api/evidence/${esc(d)}" target="_blank" rel="noopener">${esc(shortD(d))}</a> ${i === 'sealed' ? '<span class="badge t-green">' + ICONS.check + 'SEALED</span>' : i === 'mismatch' ? '<span class="badge t-red">MISMATCH</span>' : ''}` : '—'}</div>`).join('')}
        <div>Policy snapshot</div><div class="mono">${esc(shortD(a.context && a.context.policy && a.context.policy.snapshotDigest))} · policies ${esc((a.context && a.context.policy && a.context.policy.policyRepoCommit) || '—')}</div>
        <div>Verifiers</div><div class="mono">qivvra-verifiers@${esc((a.evidence && a.evidence.verifierCommit) || '—')}</div></div>
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
  runningV.forEach(v => items.push(fyItem('info', '…', `${v.id} · assessment running on ${v.rev.hash}`, `${STATUS_WORD[v.assessment.status] || v.assessment.status}. Results appear here when QIVVRA decides.`, 'Watch', fyLink('run-' + v.id, openChange(v.id, 'revisions')))));
  if (ME.sysRole === 'Assurance Lead') {
    head = 'Your assurance queue'; sub = 'Changes QIVVRA blocked, and what blocks them.';
    blocked.forEach(v => items.push(fyItem('bad', '!', `${v.id} · NOT READY on ${v.rev.hash}`, vio(v).map(o => `${o.id} ${o.title}`).join('; ').slice(0, 180), 'Open gaps', fyLink('gaps-' + v.id, openChange(v.id, 'gaps')), true)));
    vms.filter(v => v.disp.code === 'INDETERMINATE').forEach(v => items.push(fyItem('warn', '?', `${v.id} · INDETERMINATE`, v.disp.reason.slice(0, 160), 'Open gaps', fyLink('ind-' + v.id, openChange(v.id, 'gaps')), true)));
    ready.forEach(v => items.push(fyItem('ok', '✓', `${v.id} · ${DISP[v.disp.code].label} on ${v.rev.hash}`, `All ${v.obls.length} obligations supported. The PR's merge check is green.`, 'Open case', fyLink('case-' + v.id, openChange(v.id, 'case')))));
  } else if (ME.sysRole === 'Contributor' && !ME.auth.length) {
    head = 'Your changes'; sub = `${access().scope} pull requests, and what QIVVRA found in them.`;
    blocked.forEach(v => { const o = vio(v)[0]; items.push(fyItem('bad', '!', `${v.id} is blocked: ${o ? o.title.toLowerCase() : 'policy violated'}`, o ? `${o.id} (${o.authority.id}) violated on ${v.rev.hash}. ${o.exec ? 'Observed: ' + o.exec.observed : ''}`.slice(0, 200) : v.disp.reason, 'See the evidence', fyLink('ev-' + v.id, openChange(v.id, 'evidence', o && o.id)), true)); });
    ready.forEach(v => items.push(fyItem('ok', '✓', `${v.id} is ${DISP[v.disp.code].label}`, `Revision ${v.rev.hash} passed every obligation. You can merge.`, 'Open case', fyLink('case-' + v.id, openChange(v.id, 'case')))));
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
    items.push(fyItem('ok', '✓', `${ready.length} change${ready.length === 1 ? '' : 's'} READY`, 'Each READY applies only to its revision, profile and evidence cutoff.', 'Show ready', 'ready'));
    items.push(fyItem(blocked.length ? 'bad' : 'ok', blocked.length ? '!' : '✓', `${blocked.length} change${blocked.length === 1 ? '' : 's'} NOT READY`, blocked.length ? 'Blocked: ' + blocked.map(x => `${x.id} ${x.title}`).join(', ') + '.' : 'Nothing is blocked.', 'Show blocked', 'notready', !!blocked.length));
  } else if (ME.sysRole === 'Admin') {
    head = 'Platform administration'; sub = 'You configure QIVVRA. You cannot see change evidence, run assurance or make decisions.';
    const p = LIVE.platform;
    if (!p) { loadPlatform().then(() => { if (route() === 'home') render(); }); items.push('<div class="fy-empty">Loading platform status…</div>'); }
    else {
      const r = p.repos[0];
      const qeOk = r && r.environment.version;
      items.push(fyItem(qeOk ? 'ok' : 'bad', qeOk ? '✓' : '!', `${p.repos.length} repository onboarded · QE ${qeOk ? 'running ' + r.environment.version.gitSha : 'not reachable'}`, `${r ? r.github : ''} · webhooks received: ${r ? r.webhooks.count : 0} · reporting via ${p.engine.reporting}`, 'Integrations', 'integrations', true));
      items.push(fyItem('info', 'U', `${ACCOUNTS.length} users across 4 roles`, 'Demo identities. Connect your identity provider for production.', 'Users and roles', 'settings'));
      items.push(fyItem('info', 'P', `${r ? r.policyRepo.policies.length : 0} policies · profile ${r && r.policyRepo.profile ? r.policyRepo.profile.id : '—'}`, `vendorpay-policies@${r ? r.policyRepo.commit : '—'} · changes need CODEOWNERS approval.`, 'Profiles', 'profiles'));
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
  const r = p.repos[0];
  const src = r.sources;
  const M = {};
  const add = (group, name, ic, status, html) => { M[name] = { group, ic, status, html }; };
  add('Change producers', 'GitHub', 'G', 'Connected', `<p>Pull requests on <b>${esc(r.github)}</b> start assessments through a signed webhook. ${src.github.adapter === 'api' ? 'Changed files are read with the GitHub API.' : 'Changed files are read from a local clone (demo mode).'}</p><div class="kv small"><div>Webhook URL</div><div class="mono">${esc(p.engine.webhookUrl)}</div><div>Deliveries</div><div>${r.webhooks.count} · last ${esc(ago(r.webhooks.lastAt))}</div><div>Reporting</div><div>${esc(p.engine.reporting)} · status check <span class="mono">qivvra/assurance</span> and one PR comment</div></div>`);
  add('Change producers', 'Azure DevOps', 'A', 'Available'); add('Change producers', 'AI-DLC adapters', 'A', 'Available'); add('Change producers', 'Coding agents', 'C', 'Available');
  add('Enterprise context', 'Jira / ADO Boards', 'J', 'Connected', `<p>The Jira key in the PR title or branch links the story and its acceptance criteria to the change.</p><div class="kv small"><div>Project</div><div>${esc(r.jiraProject)}</div><div>Source</div><div>${src.jira.adapter === 'cloud' ? 'Jira Cloud REST API' : 'Fixture files (demo): ' + esc(src.jira.path || '')}</div></div>`);
  add('Enterprise context', 'Confluence', 'C', 'Available');
  add('Enterprise context', 'Policy repositories', 'P', 'Connected', `<p>Rules come from <b>vendorpay-policies</b>, owned per area through CODEOWNERS. Every assessment freezes the exact policy versions it used.</p><div class="kv small"><div>Commit</div><div class="mono">${esc(r.policyRepo.commit || '—')}</div><div>Policies</div><div>${r.policyRepo.policies.map(x => `${esc(x.id)} v${esc(x.version)}`).join(', ')}</div><div>Exceptions in force</div><div>${r.policyRepo.exceptions.length || 'None'}</div></div>`);
  add('Enterprise context', 'Architecture records', 'A', 'Available');
  const checks = Object.values(r.verifiers.catalog || {}).reduce((n, v) => n + Object.keys(v.checks || {}).length, 0);
  add('Verification', 'Test frameworks', 'T', 'Connected', `<p>QIVVRA's own Playwright verifiers, kept outside the application repository so a team cannot weaken the checks on its own change.</p><div class="kv small"><div>Repository</div><div class="mono">qivvra-verifiers@${esc(r.verifiers.commit || '—')}</div><div>Verifiers</div><div>${Object.entries(r.verifiers.catalog || {}).map(([k, v]) => `${esc(k)} ${esc(v.name)}`).join(' · ')}</div><div>Checks</div><div>${checks}</div><div>Runner</div><div>${esc(r.verifiers.adapter)}</div></div>`);
  add('Verification', 'Jira Xray', 'X', 'Connected', `<p>The team's own test results for each commit, in Xray's JUnit import format. Shown as context; they never decide the disposition.</p><div class="kv small"><div>Source</div><div>${esc(src.xray.adapter)} · ${esc(src.xray.path)}</div></div>`);
  const v = r.environment.version;
  add('Verification', 'QE environment', 'Q', v ? 'Connected' : 'Error', v ? `<p>Verifiers run only when this environment reports the PR's exact commit.</p><div class="kv small"><div>URL</div><div class="mono">${esc(r.environment.base_url)}</div><div>Running</div><div class="mono">${esc(v.app)} ${esc(v.version)} · ${esc(v.gitSha)}</div><div>Environment</div><div>${esc(v.environment)}</div></div>` : `<p class="s-Error">Not reachable at ${esc(r.environment.base_url)}</p><p>New assessments wait for it, then end INDETERMINATE if it never reports the commit. Existing dispositions stay valid.</p>`);
  add('Verification', 'Evidence store', 'E', 'Connected', `<p>Write-once, content-addressed storage. Every object is re-hashed when read.</p><div class="kv small"><div>Objects</div><div>${p.evidence.objects} · ${(p.evidence.bytes / 1024).toFixed(0)} KB</div><div>Location</div><div class="mono">${esc(p.evidence.store)}</div></div>`);
  add('Delivery', 'CI/CD', 'C', 'Connected', `<p>A GitHub Actions job deploys each PR commit to QE and runs the team's tests.</p>`);
  add('Delivery', 'Release systems', 'R', 'Available'); add('Delivery', 'Change management', 'C', 'Available'); add('Delivery', 'Incident systems', 'I', 'Available');
  return M;
}
function viewIntegrations() {
  if (!LIVE.platform) { loadPlatform().then(() => { if (route() === 'integrations') render(); }); return `<div class="ph"><div><h1>Integrations</h1><p class="sub">Loading live status…</p></div></div>`; }
  const M = integMap(), groups = ['Change producers', 'Enterprise context', 'Verification', 'Delivery'];
  const err = M['QE environment'].status === 'Error' ? `<div class="notice red"><span><b>QE environment not reachable.</b> New assessments cannot verify until it reports the PR's commit at /version.</span></div>` : '';
  return `<div class="ph"><div><h1>Integrations</h1><p class="sub">Live status of the systems QIVVRA reads from and reports to.</p></div><div class="acts"><button class="btn" data-action="refresh-platform">Refresh</button></div></div>
    ${err}
    <div class="integ">${groups.map(g => `<section class="col" aria-label="${g}"><h2>${g}</h2>${Object.entries(M).filter(([, x]) => x.group === g).map(([n, x]) => `<button class="itile" data-action="integ" data-id="${esc(n)}"><span class="ic">${x.ic}</span><span><b>${esc(n)}</b><small class="s-${x.status}">${x.status}</small></span></button>`).join('')}</section>`).join('')}</div>`;
}
function integDetail(name) {
  const M = integMap() || {}; const x = M[name];
  if (!x) return [name, '<p>Unknown integration.</p>', ''];
  return [name, x.html || `<p>${esc(name)} is available for this organisation but not connected. Connecting it needs an administrator to supply credentials and scope.</p><div class="kv small"><div>Status</div><div>Available</div><div>Role</div><div>${esc(x.group)}</div></div><p class="small muted">Nothing from ${esc(name)} contributes evidence to any current assurance case.</p>`, x.group];
}
function viewProfiles() {
  if (!LIVE.platform) { loadPlatform().then(() => { if (route() === 'profiles') render(); }); return `<div class="ph"><div><h1>Assurance profiles</h1><p class="sub">Loading…</p></div></div>`; }
  const r = LIVE.platform.repos[0], pr = r.policyRepo.profile || {}, pols = r.policyRepo.policies;
  const rules = (pr.disposition || []).map(d => `${d.when} → ${String(d.result).replace(/_/g, ' ')}`);
  const mappings = pols.flatMap(p => p.obligations.map(o => [`${o.id}`, `${o.evidence.verifier}/${o.evidence.check}`]));
  return `<div class="ph"><div><h1>Assurance profiles</h1><p class="sub">Profiles decide which obligations matter, who says so, what blocks, and which verifiers produce evidence. Source: vendorpay-policies@${esc(r.policyRepo.commit || '—')}.</p></div></div>
    <div class="grid2 grid-side">
      <div class="plist"><button class="pitem on"><b>${esc(pr.title || pr.id || 'Profile')}</b><div class="small muted">Used by ${esc(r.app)} (${esc(r.github)})</div></button></div>
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
    <div class="tbl-wrap" style="border:0;border-top:1px solid var(--line);border-radius:0 0 12px 12px"><table class="persona-tbl"><thead><tr><th>Person</th><th>Persona</th><th>Role and authority</th><th>Uses QIVVRA to</th></tr></thead><tbody>
    ${(LIVE.users || []).map(a => `<tr${a.email === ME.email ? ' style="background:#EEF2FD"' : ''}><td><b>${esc(a.name)}</b>${a.email === ME.email ? ' <span class="small muted">(you)</span>' : ''}<div class="mono small muted">${esc(a.email)}</div></td><td>${esc(a.role)}</td><td>${rchips(a).replace('margin-left:6px', '')}</td><td>${esc(a.job)}</td></tr>`).join('')}
    <tr><td><b>Producer</b><div class="small muted">human developer or AI agent</div></td><td>Change producer</td><td><span class="rchip">No login</span></td><td>Receives findings on the pull request and pushes fixes</td></tr></tbody></table></div></div>`
    : `<div class="card" style="margin-top:20px"><h2>Your access</h2><p class="small" style="margin:0 0 8px">${rchips(ME).replace('margin-left:6px', '')}</p><ul class="small" style="margin:0;padding-left:18px">${canList(ME).map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="small muted" style="margin:10px 0 0">Roles are assigned by your QIVVRA admin and enforced by the server.</p></div>`;
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
const STAGES = [['intake', 'Receiving revision'], ['gather', 'Gathering GitHub, Jira, Xray and policies'], ['environment', 'Confirming QE runs this commit'], ['freeze', 'Freezing context'], ['verify', 'Executing independent verifiers'], ['decide', 'Deriving disposition'], ['report', 'Reporting to the pull request']];
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
  const yaml = `apiVersion: qivvra/v1\nkind: Exception\nid: EXC-0001\npolicy: ${o.authority.id}\nobligations: [${o.id}]\nscope:\n  repository: ${vm.change.repository}\n  jira: ${vm.id}\nreason: <why this change may ship before the obligation is met>\ncompensating_control: <what reduces the risk meanwhile>\napproved_by: "${o.authority.owner}"\ngranted: ${today.toISOString().slice(0, 10)}\nexpires: ${exp}\n`;
  return `<p class="small" style="margin:0">Exceptions are not clicked into existence. They are a file in <b>vendorpay-policies</b>, added by pull request and approved by the rule's owner (<span class="mono">${esc(o.authority.owner)}</span>) through CODEOWNERS. The validator rejects exceptions to rules that allow none, and anything longer than the rule's maximum.</p>
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
    case 'request-rerun': stop(); { const vm = curVM(); api(`/api/ui/assessments/${encodeURIComponent(vm.assessment.id)}/request-rerun`, { method: 'POST' }).then(r => { toast(r.ok ? 'Re-run requested. It shows in the change activity for the Assurance Lead.' : (r.data.message || 'Request failed.')); refresh(true); }); } break;
    case 'view-rev': stop(); LIVE.rev[S.changeId] = id; LIVE.caseRev[S.changeId] = id; render(); break;
    case 'case-rev': stop(); LIVE.caseRev[S.changeId] = id; render(); break;
    case 'exception': stop(); { const vm = curVM(); const o = vm.obls.find(x => x.id === id); openDrawer('Propose exception', `${esc(o.id)} · through the policy repository`, exceptionDrawer(o, vm)); } break;
    case 'refresh-platform': stop(); LIVE.platform = null; render(); break;
    case 'profile-version': stop(); toast('Profiles change through a pull request on vendorpay-policies, approved by its CODEOWNERS.'); break;
    case 'route': case 'decide': case 'return-finding': case 'import-rev': case 'revoke': case 'exc-approve': case 'exc-reject':
      stop(); toast('In the live product this happens on GitHub: findings go to the PR automatically, new commits arrive by webhook, and rules and exceptions change by pull request to the policy repository.'); break;
    case 'flow': case 'reset-arm': case 'reset-do': case 'reset-cancel': stop(); break;
    case 'signout': stop(); api('/api/ui/logout', { method: 'POST', allow401: true }).then(() => { stopPolling(); LIVE.platform = null; LIVE.users = null; $('#acct-pop').hidden = true; $('#drawer-root').innerHTML = ''; showLogin({ t: 'info', m: 'You have signed out.' }); }); break;
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
  await enterLive(r.data.account, true);
}
async function enterLive(account, fresh) {
  ME = ACCOUNTS.find(a => a.email === account.email) || account;
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

/* ---------- Identities beyond the prototype's six: one per rule-owning authority ---------- */
if (!ACCOUNTS.some(a => a.email === 'v.bose@qivvra.demo')) ACCOUNTS.splice(ACCOUNTS.length - 1, 0,
  { email: 'v.bose@qivvra.demo', short: 'V. Bose', name: 'Vikram Bose', role: 'Compliance Officer', tagRole: 'Compliance Officer', sysRole: 'Viewer', auth: ['Compliance'], initials: 'VB', job: 'Owns audit-trail rules and compliance exceptions' },
  { email: 'a.pillai@qivvra.demo', short: 'A. Pillai', name: 'Arjun Pillai', role: 'Platform Engineering Lead', tagRole: 'Platform Lead', sysRole: 'Contributor', auth: ['Platform'], initials: 'AP', job: 'Owns build, deploy and environment rules' });
/* Authority holders review their area's rules on every application, so they are not scoped to one. */
function access(a) {
  a = a || ME;
  if (a.sysRole === 'Admin') return { routes: ['home', 'integrations', 'profiles', 'org-settings'], scope: 'none' };
  if (a.sysRole === 'Assurance Lead') return { routes: ['home', ...ALL_CHANGE, 'integrations', 'profiles', 'org-settings'], scope: 'all' };
  if (a.sysRole === 'Contributor') return { routes: ['home', ...ALL_CHANGE, 'org-settings'], scope: a.auth.length ? 'all' : 'VendorPay' };
  return { routes: ['home', ...ALL_CHANGE, 'org-settings'], scope: 'all' };
}
function homeLabel(a) {
  a = a || ME;
  if (a.sysRole === 'Admin') return 'Platform';
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
  if (r.ok) await enterLive(r.data.account, false);
  else showLogin(LIVE.deep ? { t: 'info', m: `Sign in to open assessment ${LIVE.deep}.` } : null);
})();
