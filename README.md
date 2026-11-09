# prcheck-platform

The PRCheck.live engine. When a pull request is opened or updated, it decides whether the change is ready to ship, from evidence it gathered itself, and reports the decision back to the PR as a required status check.

```
GitHub webhook ──▶ intake ──▶ gather ──▶ freeze ──▶ environment ──▶ verify ──▶ functional ──▶ decide ──▶ report
 (signed)          Jira key    GitHub      context     QE /version     V1–V5      story ACs      every      status checks
                               Jira        SHA-256     = PR head?      policy     approved       required   + PR comment
                               Xray                                    lane       agent checks   lane
                               policy repo
```

When PRCheck.live says READY, nothing the application's profile requires is pending: every obligation **and** every acceptance criterion of the linked story is supported on this exact commit.

## What each step does

| Step | What happens | Code |
|---|---|---|
| Intake | Verifies the webhook's HMAC signature and drops redeliveries. Takes the Jira key from the PR title, then the branch. Posts a **pending** status. | `server.ts`, `pipeline.ts` |
| Gather | Changed files (GitHub), the story and its acceptance criteria (Jira), the team's results for this commit (JUnit, as imported to Xray), and the policies that apply (the policy repo's own selector). | `sources/*` |
| Freeze | Writes everything gathered into one context object, stores it write-once under its SHA-256, and records the digest. Later edits to Jira or policies never change this assessment. | `evidence-store.ts` |
| Environment | Polls QE `/version` until it reports the PR head commit. If it never does, nothing is verified and the result is INDETERMINATE. | `environment.ts` |
| Verify | Runs the `prcheck-verifiers` suite against QE and stores its evidence record write-once. | `verify.ts` |
| Functional | Sends a functional **mission** (commit, QE URL, frozen story and criteria, changed files, identity names, time budget) to the agent core. The `frozen-suites` adapter runs the story's approved suite (`functional/suites/<story>.yaml` in the verifiers repo) and returns one result per acceptance criterion; evidence is sealed. A criterion is NOT ASSESSED when it has no approved check or its text changed in Jira after approval. | `agent-core.ts` |
| Regression | Selects earlier stories by change impact: each story's approved suite names its components (`components:` in `functional/suites/<story>.yaml`); a change selects every earlier story that shares a component with the files it touches, and a changed source file mapped to no component selects all of them (full regression, never fewer). The selected suites run on the same QE build; each criterion is judged like the functional lane. | `regression.ts` |
| Imported evidence | Reads the results from other tools the profile requires (`imported_evidence`: security scan as SARIF, dependency audit as `npm audit --json`, performance as a k6 summary), written by the team's CI to `<imports path>/<commit>/<id>.json`. Waits for them, rejects a result about another commit or build, seals each file, and judges it against its gate. Suppressed SARIF results are shown with their justification and not counted. | `imports.ts` |
| Decide | Policy lane: maps each obligation to its check's result and applies the profile rules (first match wins; exceptions cover INSUFFICIENT, never VIOLATED). Then across lanes: any violation, failed criterion, broken earlier-story criterion or tool result outside its gate → NOT READY; anything a required lane could not prove → INDETERMINATE ("pending"); otherwise the policy disposition stands. The profile's `required_evidence` lists the lanes. | `decide.ts` |
| Report | Sets the required commit status `prcheck/assurance` (all lanes), informational `prcheck/functional`, `prcheck/regression` and `prcheck/imported-evidence`, and one PR comment with the lanes, what blocks the change, unmet story promises, owners and digests. | `report.ts` |

The team's test results are gathered and shown, but they **never** decide the outcome. They show what the team checked, which is the contrast PRCheck.live exists to expose.

## Live demo on one Linux machine

To run it for real (a GitHub org, a self-hosted runner as QE, and a Cloudflare tunnel to the engine), follow `deploy/linux-local/README.md`.

## Run the demo (simulated, no GitHub)

Everything runs locally against VendorPay PR #482. You need PostgreSQL with a `vendorpay` database (for the app) and a `prcheck` database (for the engine), and ports 3000 and 4000 free. The repos sit side by side: `vendorpay-app`, `vendorpay-policies`, `prcheck-verifiers`, `prcheck-platform`.

```bash
npm ci && npm run db:migrate
(cd ../vendorpay-app && npm ci) && (cd ../vendorpay-policies && npm ci) && (cd ../prcheck-verifiers && npm ci)
scripts/demo.sh
```

For each commit the script plays every actor: it deploys that commit as QE, runs the team's CI, sends a signed `pull_request` webhook, and waits for PRCheck.live:

```
=== PR #482 @ 08557fb  VP-184: bank-change request and approval
Team CI tests="25" failures="0"
PRCheck.live  NOT READY — violated: FIN-001.1, FIN-002.1, FIN-002.3
=== PR #482 @ 900652c  VP-184: block self-approval of bank changes
Team CI tests="26" failures="0"
PRCheck.live  NOT READY — violated: FIN-002.1, FIN-002.3
=== PR #482 @ 684fa4f  VP-184: hold scheduled payments on bank change
Team CI tests="29" failures="0"
PRCheck.live  READY — all 14 obligations supported
```

Without `PRCHECK_GITHUB_TOKEN`, statuses and PR comments go to `data/outbox/<assessment>/`. Sample output from a real run is in `docs/sample-run/`. The UI is at http://localhost:4000 while the engine runs (`npm run dev`); see **The UI** below.

Re-assess one commit by hand: `npm run assess -- --repo vendorpay --pr 482 --sha 900652c --head-ref feature/VP-184-bank-change --title "VP-184: ..."`.

## Connecting the real systems

Every source has a local adapter, used by the demo, and a cloud adapter. Switch them in `prcheck.config.yaml`.

| System | Local (demo) | Production | Credentials |
|---|---|---|---|
| GitHub: changed files | `local-git` (git diff) | `api` (compare API) | `PRCHECK_GITHUB_TOKEN` (GitHub App installation token) |
| GitHub: status + comment | outbox files | statuses and issue-comments APIs | same |
| GitHub: webhook | `scripts/send-webhook.mjs` | GitHub App webhook to `/webhooks/github` | `WEBHOOK_SECRET` |
| Jira | `fixtures/jira/*.json` | `cloud` (REST v3, ADF parsed for numbered ACs) | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` |
| Xray | JUnit per commit in `data/team-results/<sha>/` | `cloud`: Xray Cloud GraphQL, the Test Execution labelled `commit-<sha>` | Client ID + secret (entered at onboarding) |
| Policies | sibling checkout | checkout of the policy repo at its `main` | read-only deploy key |
| Verifiers | `local-playwright` (spawned) | `github-dispatch` to the verifiers repo's `verify.yml` (not wired yet) | — |
| Evidence store | `data/evidence`, files mode 0444 | S3 with Object Lock (compliance mode) | — |
| Index | PostgreSQL `prcheck` | PostgreSQL | `DATABASE_URL` |

On GitHub, make `prcheck/assurance` a **required status check** on `main`. NOT READY and INDETERMINATE then block the merge.

## The UI

The UI is the approved PRCheck.live prototype itself (`ui/prototype.html`), unchanged, with its demo data replaced by live engine data through `public/live.js`. The engine serves both at `/`, and the PR comment links (`/assessments/<id>`) open straight into that assessment's case after sign-in.

| Prototype screen | Live behaviour |
|---|---|
| Sign-in (password + verification code) | Checked by the engine; signed, HttpOnly session cookie |
| Home / For you | Built per role from real assessments (queue, blocked changes, your authority's rules, release readiness, platform status) |
| Command Center | One row per pull request, latest revision's disposition from the engine |
| Change overview | Jira story, head commit, changed files, components, provenance, team results |
| Revisions + compare | One revision per pushed commit; every obligation's state across commits |
| Obligations, Gaps, Evidence, Traceability | Real obligation states, verifier observations, HTTP and API traces, sealed digests |
| Assurance case | Engine verdict, proof digests (links re-hashed on read), assessment timeline |
| Re-run assurance | Starts a real assessment; stages stream from the engine |
| Integrations, Profiles, Settings | Live configuration: GitHub, Jira, policy repo, verifiers, QE `/version`, evidence store, users |

Simulated-only prototype actions are not faked. Findings reach the producer as the PR comment, new commits arrive by webhook, and rules and exceptions change by pull request to the policy repository (the UI shows the exact exception file to propose).

**Roles are enforced on the server** (`src/auth.ts`). Members live in the `members` table; on first start the engine creates these demo members (password `PRCheck@2026`, code `246810`):

| Account | Role | Can |
|---|---|---|
| a.rao@prcheck.demo | Assurance Lead | Everything about changes; re-run assurance; integrations and profiles |
| r.das@prcheck.demo | Contributor (VendorPay only) | Read VendorPay changes; request a re-run |
| m.iyer@prcheck.demo | Viewer + Authority: Finance | Read; sees finance rules (FIN-001..003) first |
| s.qureshi@prcheck.demo | Contributor + Authority: Security | Read all changes; sees security rules (SEC-001) first |
| v.bose@prcheck.demo | Viewer + Authority: Compliance | Read; sees compliance rules (CMP-001) first |
| a.pillai@prcheck.demo | Contributor + Authority: Platform | Read all changes; sees platform rules (PLT-001) first; request a re-run |
| k.shah@prcheck.demo | Viewer | Read-only release readiness |
| p.nair@prcheck.demo | Admin | Integrations, users, profiles; **no** change evidence |

Set `PRCHECK_SESSION_SECRET` so sessions survive restarts.

### Members (Platform Admin)

**Integrations → Members** lists everyone who uses PRCheck.live, with search and filters by role and application. The Admin can **add**, **edit** and **deactivate / reactivate** members. Each member has:

| Setting | Meaning |
|---|---|
| Name, work email, designation | Who they are; the email can't change |
| Role | Assurance Lead, Contributor, Viewer or Platform Admin: what they can do |
| Authority (optional) | Finance, Security, Compliance, Platform: which rules they own |
| Applications | The applications they work on, or **all applications** (including ones onboarded later) |
| Initial password | Demo sign-in only; production uses the identity provider (SSO) |

**Bulk: Import CSV / Export CSV.** The Import screen shows the template (columns, rules, sample rows) with **Download template** and **Copy**. Columns: `email, name, designation, role, authorities, applications, password` (authorities and applications separated by `;`, applications by key or name, or `all`). The engine checks every row first and shows a preview: **Add**, **Update** (with exactly what changes), **No change**, or **Error** (with the reason). Only valid rows are imported; members are never removed or deactivated by an import. New members without a password get a generated one, offered once as a download. **Export CSV** writes the current members in the same format.

After signing in, every member sees **one card per application** on Home (changes, NOT READY / READY counts), and only those applications' changes anywhere in PRCheck.live. The engine enforces it on every request: removing an application hides its changes on the member's next request, and deactivating a member ends their session at once. Rules: a Platform Admin has no applications or authority (sees no change evidence); the Admin can't deactivate themselves or remove their own Admin role; there's always at least one active Admin. Every change is written to `platform_audit`.

## Onboarding an application (Admin)

An Admin adds an application in the UI: **Integrations → Add application**. Eleven steps; each one has a **Test connection** button that tries the real system, and **Next** stays disabled until the test passes (warnings are allowed).

| Step | The Admin gives | Tested for real |
|---|---|---|
| Application | Display name, application key | Key format; not already onboarded |
| GitHub | `owner/repo`, base branch, and how to connect: the organisation connection (GitHub App / `PRCHECK_GITHUB_TOKEN`), an **access token for this repository**, or a local clone (demo) | Repository and branch reachable with those credentials; webhook secret set |
| Jira | Project key; Jira Cloud site, service-account email, API token (or issue files) | Project found with those credentials |
| Xray | **Xray Cloud**: client ID and client secret (API key), or JUnit files (demo); wait time | Authenticates with Xray; counts the project's test cases and executions. The team CI labels each commit's Test Execution `commit-<sha>` |
| Policy repository | Git URL (cloned) or checkout path; optional read-only token | Clones, installs, runs `validate.ts`; the key is registered in `catalog/components.yaml`; profile exists; counts policies and obligations |
| Verifiers repository | Git URL or path; optional token | Playwright lists the checks; V1 exists; **every obligation has a check** (missing ones are listed); finds the login variables the verifiers read |
| QE environment | Base URL, deploy wait, log file | `/version` answers with a `gitSha` |
| Channels | Which of **Web UI** (address, browsers), **API** (base URL, optional OpenAPI specification) and **MCP server** (endpoint, optional token) the application offers on QE | UI and API answer; the specification parses (paths counted); the MCP server initialises over streamable HTTP and lists its tools |
| Assurance suites | The **PRCheck.live-owned** suites repository (functional and regression suites per story), the agent core (adapter, pinned version, time budget), and optionally the **team's automation repository, read-only** | Suites cannot live in the team's repository; the suite runner exists; each `functional/suites/<story>.yaml` names only checks that exist, with approved / proven / generated counts. The team repository is analysed like a brownfield repository (framework, language, test folders, channels, tags) and never written to. Required when the profile requires the functional lane |
| Test identities | **Values only.** The names, roles and purposes come from `identities.yaml` in the verifiers and suites repositories | Every declared login has a value |
| Review and create | | **Every step is tested again on the server** before saving |

The approved prototype (`ui/prototype.html`) has the same wizard with simulated tests, including a ready-made example (Claims Portal) and the failure cases; the live layer replaces it with these real tests.

After saving, the application is live at once (no restart) and the screen shows the webhook URL and required check to set on GitHub. Admins can **Edit** (stored secrets are kept unless replaced) and **Pause** (webhooks are acknowledged and ignored). Every create, update, pause and resume is written to `platform_audit`.

- Secrets (GitHub token, Jira token, Xray client secret, repository tokens, MCP token, test logins) are encrypted with AES-256-GCM using `PRCHECK_SECRET_KEY` (falls back to `WEBHOOK_SECRET`), and never returned by the API. Use a KMS or vault in production.
- Applications in `prcheck.config.yaml` still work and are shown as "Configuration file"; they are edited in the file.
- The key must match the policy repository's catalog: the policy owners register an application there first, by pull request. PRCheck.live does not let an Admin invent rules.
- Assurance Leads can see the application list; only Admins can test, create, edit or pause. Contributors and Viewers get 403.

## Generated checks: trust graduation (Assurance Lead)

The agent core writes checks; PRCheck.live never counts one until it has earned it. **Generated checks** (Assurance Lead only) lists every agent-produced check per application:

| Status | Meaning | Counts? |
|---|---|---|
| Requested | PRCheck.live asked the agent core for a verifier: an obligation in the policy repository names a check no active verifier has | No: the obligation is NOT ASSESSED |
| Generated | The agent core delivered the code and its **fault proof** (the check fails on a seeded fault) | No |
| Proven | PRCheck.live ran it **3 times on QE** and it passed every time, and a fault proof exists | No |
| Approved | The Lead read the code and approved it, with a note. The decision is a **commit in the repository** by the Lead and a row in `suite_reviews` | Yes |
| Returned | The Lead sent it back with what to change; the agent core regenerates it | No |

- **New rules, verifiers on the fly.** Every assessment (and **Request from agent core** on the page) compares the policy repository's obligations with the active verifiers. Missing ones are requested in the verifiers repository's `generated/manifest.yaml`, which the agent core watches; it writes the check into `generated/`. Approval moves the spec file into `verifiers/`; a file holding several checks is approved as a whole, so every check in it must be proven first.
- **Story criteria.** Functional checks per acceptance criterion carry the same status in `functional/suites/<story>.yaml`. Approval records the criterion's text digest, so an edit in Jira makes it stale again.
- Until approved, the obligation or criterion is NOT ASSESSED and the change is INDETERMINATE: never READY with something pending. The profile treats any NOT ASSESSED obligation this way, whatever its severity.
- The gap for a waiting rule or criterion links the Lead straight to the review; Contributors see that it waits for the Lead. Contributors and Viewers cannot open the page or its API.
- Proof runs share QE with assessments and queue behind them (`exclusive` in `pipeline.ts`). Code: `src/suites.ts`.
- Scenario: `fixtures/scenarios/new-policy/` (CMP-002 "bank change decisions are justified", and the agent core's output for it).

## Agent core (myDiya)

PRCheck.live talks to the myDiya agent core over a versioned mission protocol, `prcheck.agent-core/v1` (**[docs/agent-core-protocol.md](docs/agent-core-protocol.md)**). The core produces; PRCheck.live runs the frozen checks and decides.

| Mission | Sent when | Delivered | Effect |
|---|---|---|---|
| `impact` (myDelta) | Every assessment, for the regression lane | Earlier stories the change can affect, with reasons | Merged into the component-overlap selection: may add stories, never removes one. Core down or slow: overlap stands, and the assessment says so |
| `verifier` | A rule's check has no active verifier (new or changed policy), or a Lead returned a delivered verifier | Spec under `generated/` + manifest entries with a fault proof | Committed as **myDiya agent core**, status *generated* |
| `suite` | A story's criterion has no checks or stale ones, or a Lead returned them | Spec under `functional/` + manifest criteria with fault proofs | Committed as **myDiya agent core**, status *generated* |

- Connect it in **Add application → Assurance suites**: the core's address, a token (encrypted) and an optional version pin. The test calls `/v1/info` and checks the protocol and the pin. File-configured applications use `agent_core: { url, version }` and `PRCHECK_AGENT_CORE_TOKEN`.
- Missions run in the background and are recorded in `agent_missions`; the engine resumes open ones after a restart. **Generated checks** shows the connected core, each item's mission and status, and the mission history.
- `reference-core/server.mjs` implements the protocol for development and tests (`AGENT_CORE_TOKEN=… PORT=4100 node reference-core/server.mjs`). It is a contract test double with a small pattern library; for anything outside it, it fails the mission honestly. The myDiya core implements the same endpoints with its agents.

## Contributor requests

Contributors can't change a verdict, a rule or a check, but they can talk to the people who can:

| Request | Where | Who sees it | Closed when |
|---|---|---|---|
| **Request re-run** | Revisions (or any change screen header) | Assurance Lead's queue; button shows "Re-run requested" | The Lead re-runs that revision, or a newer commit supersedes it |
| **Acknowledge** a finding | Gaps, on a failed obligation | Lead's queue and the gap | The obligation is supported on a newer commit |
| **Dispute** a check | Gaps, on a failed obligation | Lead's queue (needs an answer) | The Lead answers: *finding stands*, or *check will be corrected* (by PR to the verifiers repo) |

Every request and answer is also written to the assessment's timeline. The Contributor's home shows the state of their own requests.

## API

| Method | Path | |
|---|---|---|
| POST | `/webhooks/github` | `pull_request` opened, synchronize, reopened, ready_for_review. 401 if the signature is wrong. |
| POST | `/api/ui/login/password`, `/api/ui/login`, `/api/ui/logout` | Sign-in (password, then code) |
| GET | `/api/ui/me`, `/api/ui/changes` | Current user and access; changes visible to that user |
| POST | `/api/ui/assessments/:id/rerun` | Assurance Lead only |
| POST | `/api/ui/assessments/:id/request-rerun` | Contributor only; one open request per revision (409 otherwise) |
| POST | `/api/ui/assessments/:id/findings/:obligation/acknowledge` | Contributor: "seen, fix in progress", with an optional fix date |
| POST | `/api/ui/assessments/:id/findings/:obligation/dispute` | Contributor: "the check is wrong", with a reason |
| POST | `/api/ui/requests/:id/resolve` | Assurance Lead answers a dispute: `upheld` or `check_changed` |
| GET | `/api/ui/platform`, `/api/ui/users` | Admin and Assurance Lead; users for Admin only |
| GET, POST | `/api/ui/members` | List or add members (Admin) |
| POST | `/api/ui/members/import` | `{ rows, dryRun }`: check (dry run) or apply a CSV import (Admin) |
| PUT | `/api/ui/members/:email` | Change role, authority, applications, or reset the password (Admin) |
| POST | `/api/ui/members/:email/status` | `active` or `disabled` (Admin) |
| GET | `/api/ui/applications` | Every application and where it is defined (Admin, Assurance Lead) |
| POST | `/api/ui/applications/test` | Test one onboarding step: `{ step, draft }` (Admin) |
| POST, PUT | `/api/ui/applications`, `/api/ui/applications/:key` | Create or update; every step re-tested, 422 with results if any fails (Admin) |
| POST | `/api/ui/applications/:key/status` | `active` or `paused` (Admin) |
| GET | `/api/ui/applications/:key`, `/api/ui/applications/audit` | Settings without secrets; platform audit log (Admin) |
| GET | `/api/assessments?pr=` | Latest 100 (signed-in user's scope, or `x-prcheck-key: <WEBHOOK_SECRET>` for scripts) |
| GET | `/api/assessments/:id` | Assessment, obligation results, timeline |
| GET | `/api/evidence/:digest` | A stored object, re-hashed on read; 500 if it fails the integrity check |
| GET | `/health` | |

## Data model

- `assessments`: one per PR head commit, with status, disposition and the three digests (context, evidence, report).
- `obligation_results`: one row per obligation, with policy version, check and state.
- `assessment_events`: the timeline.
- `evidence_objects`: an index of what is in the write-once store.
- `webhook_deliveries`: makes redeliveries idempotent.
- `applications`: applications onboarded in the UI, with their credentials encrypted.
- `platform_audit`: who changed the platform's configuration.
- `members`: who uses PRCheck.live, their role, authorities and applications.
- `change_requests`: re-run requests, acknowledgements and disputes, and the Lead's answers. Acknowledge and dispute work on obligations and on acceptance criteria (`VP-184-AC5`).
- `suite_reviews`: every proof, approval and return of a generated check, by whom, with the repository commit.
- `imported_results`: per assessment, each required tool result, its gate, what was measured, top findings and the sealed digest.
- `regression_results`: per assessment, each re-verified criterion of an earlier story, its state and why the story was selected.
- `criterion_results`: per assessment, each acceptance criterion's state, its checks, and whether those checks were approved, stale or missing. `assessments.lanes` records the required lanes and anything pending.

## Known limits of this MVP build

- One assessment runs at a time (a shared QE environment). A newer push queues behind the running one.
- The Xray Cloud adapter is implemented but has not yet been run against a live Xray instance; the demo uses JUnit files. The GitHub-dispatched verifier run is a documented interface only.
- `/version` reports a 7-character commit, so the engine compares the short SHA.
- The Jira fixtures hold VP-184 as it is today (5 acceptance criteria), so the assessments of commits 1 and 2 also show 5. In real Jira, the frozen context captures the story as it was at assessment time.
- Sign-in uses a password per member plus a demo verification code; connect an identity provider (OIDC/SAML) for production. There is no self-service password change yet.
- Onboarding shows the GitHub webhook and required check to set; the GitHub App would set them automatically. The verifiers run on the engine host (`local-playwright`).
- The agent core in this repository is the reference implementation of the protocol; connecting the myDiya agent core is configuration, not code. Self-healing of approved checks is not part of `v1` yet.
- Simulated prototype workflows (routing missing intent, approving exceptions in-app) are replaced by their real GitHub equivalents, not by new UI.

## How the role sets connect

| PRCheck.live user | Authority | GitHub team (CODEOWNERS in vendorpay-policies) | Rules owned |
|---|---|---|---|
| Meera Iyer | Finance | `finance-controls` | FIN-001, FIN-002, FIN-003 |
| Sana Qureshi | Security | `security` | SEC-001 |
| Vikram Bose | Compliance | `compliance` | CMP-001 |
| Arjun Pillai | Platform | `platform-eng` | PLT-001 |
| Anika Rao | (Assurance Lead) | `prcheck-assurance-leads` | Profiles, catalog |

PRCheck.live does not yet read GitHub team membership: keep the authority tags here and the team members on GitHub in step by hand.

VendorPay's own users (password `VendorPay@2026`) are separate. PRCheck.live's verifiers sign in to VendorPay as ravi.kumar (Procurement), neha.joshi (Finance Ops), m.fernandes and j.thomas (two Finance Approvers) and audit.viewer (Auditor).

## Demo arc (PR #482, four commits)

| Commit | What changed | Verdict | Why |
|---|---|---|---|
| 08557fb | Bank-change request and approval | NOT READY | FIN-001.1, FIN-002.1, FIN-002.3 violated; VP-184 AC5 not met; 3 high dependency vulnerabilities |
| 900652c | Block self-approval | NOT READY | FIN-002.1, FIN-002.3 violated; AC5 not met; 3 high vulnerabilities |
| 684fa4f | Hold scheduled payments | NOT READY | Dependency audit: 3 high (express 4.21.2: body-parser, path-to-regexp) |
| 38e8b97 | Upgrade express to 4.22.3 | **READY** | 14 obligations, 5 acceptance criteria, 13 earlier-story criteria and 3 required tool results; nothing pending |

The team's own tests pass on every commit. The CI stand-ins in `scripts/ci/` (a SARIF scanner and a k6-format load run) produce the same formats as CodeQL/Semgrep and k6; `npm audit` is the real tool.
