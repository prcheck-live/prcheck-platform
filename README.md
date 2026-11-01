# qivvra-platform

The QIVVRA engine. When a pull request is opened or updated, it decides whether the change is ready to ship, from evidence it gathered itself, and reports the decision back to the PR as a required status check.

```
GitHub webhook ──▶ intake ──▶ gather ──▶ freeze ──▶ environment ──▶ verify ──▶ decide ──▶ report
 (signed)          Jira key    GitHub      context     QE /version     V1–V5      profile    status check
                               Jira        SHA-256     = PR head?      evidence   rules      + PR comment
                               Xray                                    SHA-256
                               policy repo
```

## What each step does

| Step | What happens | Code |
|---|---|---|
| Intake | Verifies the webhook's HMAC signature and drops redeliveries. Takes the Jira key from the PR title, then the branch. Posts a **pending** status. | `server.ts`, `pipeline.ts` |
| Gather | Changed files (GitHub), the story and its acceptance criteria (Jira), the team's results for this commit (JUnit, as imported to Xray), and the policies that apply (the policy repo's own selector). | `sources/*` |
| Freeze | Writes everything gathered into one context object, stores it write-once under its SHA-256, and records the digest. Later edits to Jira or policies never change this assessment. | `evidence-store.ts` |
| Environment | Polls QE `/version` until it reports the PR head commit. If it never does, nothing is verified and the result is INDETERMINATE. | `environment.ts` |
| Verify | Runs the `qivvra-verifiers` suite against QE and stores its evidence record write-once. | `verify.ts` |
| Decide | Maps each obligation in the frozen snapshot to its check's result, then applies the profile rules (first match wins). Exceptions can cover INSUFFICIENT, never VIOLATED. | `decide.ts` |
| Report | Sets the commit status `qivvra/assurance` and creates or updates one PR comment listing what blocks the change, who owns it, and the digests. | `report.ts` |

The team's test results are gathered and shown, but they **never** decide the outcome. They show what the team checked, which is the contrast QIVVRA exists to expose.

## Live demo on one Linux machine

To run it for real (a GitHub org, a self-hosted runner as QE, and a Cloudflare tunnel to the engine), follow `deploy/linux-local/README.md`.

## Run the demo (simulated, no GitHub)

Everything runs locally against VendorPay PR #482. You need PostgreSQL with a `vendorpay` database (for the app) and a `qivvra` database (for the engine), and ports 3000 and 4000 free. The repos sit side by side: `vendorpay-app`, `vendorpay-policies`, `qivvra-verifiers`, `qivvra-platform`.

```bash
npm ci && npm run db:migrate
(cd ../vendorpay-app && npm ci) && (cd ../vendorpay-policies && npm ci) && (cd ../qivvra-verifiers && npm ci)
scripts/demo.sh
```

For each commit the script plays every actor: it deploys that commit as QE, runs the team's CI, sends a signed `pull_request` webhook, and waits for QIVVRA:

```
=== PR #482 @ 8cafa75  VP-184: bank-change request and approval
Team CI tests="25" failures="0"
QIVVRA  NOT READY — violated: FIN-001.1, FIN-002.1, FIN-002.3
=== PR #482 @ 88b666a  VP-184: block self-approval of bank changes
Team CI tests="26" failures="0"
QIVVRA  NOT READY — violated: FIN-002.1, FIN-002.3
=== PR #482 @ aaf2a60  VP-184: hold scheduled payments on bank change
Team CI tests="29" failures="0"
QIVVRA  READY — all 14 obligations supported
```

Without `QIVVRA_GITHUB_TOKEN`, statuses and PR comments go to `data/outbox/<assessment>/`. Sample output from a real run is in `docs/sample-run/`. The UI is at http://localhost:4000 while the engine runs (`npm run dev`); see **The UI** below.

Re-assess one commit by hand: `npm run assess -- --repo vendorpay --pr 482 --sha 88b666a --head-ref feature/VP-184-bank-change --title "VP-184: ..."`.

## Connecting the real systems

Every source has a local adapter, used by the demo, and a cloud adapter. Switch them in `qivvra.config.yaml`.

| System | Local (demo) | Production | Credentials |
|---|---|---|---|
| GitHub: changed files | `local-git` (git diff) | `api` (compare API) | `QIVVRA_GITHUB_TOKEN` (GitHub App installation token) |
| GitHub: status + comment | outbox files | statuses and issue-comments APIs | same |
| GitHub: webhook | `scripts/send-webhook.mjs` | GitHub App webhook to `/webhooks/github` | `WEBHOOK_SECRET` |
| Jira | `fixtures/jira/*.json` | `cloud` (REST v3, ADF parsed for numbered ACs) | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` |
| Xray | JUnit per commit in `data/team-results/<sha>/` | Xray GraphQL test executions (not wired yet) | — |
| Policies | sibling checkout | checkout of the policy repo at its `main` | read-only deploy key |
| Verifiers | `local-playwright` (spawned) | `github-dispatch` to the verifiers repo's `verify.yml` (not wired yet) | — |
| Evidence store | `data/evidence`, files mode 0444 | S3 with Object Lock (compliance mode) | — |
| Index | PostgreSQL `qivvra` | PostgreSQL | `DATABASE_URL` |

On GitHub, make `qivvra/assurance` a **required status check** on `main`. NOT READY and INDETERMINATE then block the merge.

## The UI

The UI is the approved QIVVRA prototype itself (`ui/prototype.html`), unchanged, with its demo data replaced by live engine data through `public/live.js`. The engine serves both at `/`, and the PR comment links (`/assessments/<id>`) open straight into that assessment's case after sign-in.

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

**Roles are enforced on the server** (`src/auth.ts`), with the same demo identities and password `Qivvra@2026`, code `246810`:

| Account | Role | Can |
|---|---|---|
| a.rao@qivvra.demo | Assurance Lead | Everything about changes; re-run assurance; integrations and profiles |
| r.das@qivvra.demo | Contributor (VendorPay only) | Read VendorPay changes; request a re-run |
| m.iyer@qivvra.demo | Viewer + Authority: Finance | Read; sees finance rules first |
| s.qureshi@qivvra.demo | Contributor + Authority: Security | Read all changes; sees security rules first |
| k.shah@qivvra.demo | Viewer | Read-only release readiness |
| p.nair@qivvra.demo | Admin | Integrations, users, profiles; **no** change evidence |

Replace `ACCOUNTS` with your identity provider (OIDC/SAML) for production. Set `QIVVRA_SESSION_SECRET` so sessions survive restarts.

## API

| Method | Path | |
|---|---|---|
| POST | `/webhooks/github` | `pull_request` opened, synchronize, reopened, ready_for_review. 401 if the signature is wrong. |
| POST | `/api/ui/login/password`, `/api/ui/login`, `/api/ui/logout` | Sign-in (password, then code) |
| GET | `/api/ui/me`, `/api/ui/changes` | Current user and access; changes visible to that user |
| POST | `/api/ui/assessments/:id/rerun` | Assurance Lead only |
| POST | `/api/ui/assessments/:id/request-rerun` | Contributor only |
| GET | `/api/ui/platform`, `/api/ui/users` | Admin and Assurance Lead; users for Admin only |
| GET | `/api/assessments?pr=` | Latest 100 (signed-in user's scope, or `x-qivvra-key: <WEBHOOK_SECRET>` for scripts) |
| GET | `/api/assessments/:id` | Assessment, obligation results, timeline |
| GET | `/api/evidence/:digest` | A stored object, re-hashed on read; 500 if it fails the integrity check |
| GET | `/health` | |

## Data model

- `assessments`: one per PR head commit, with status, disposition and the three digests (context, evidence, report).
- `obligation_results`: one row per obligation, with policy version, check and state.
- `assessment_events`: the timeline.
- `evidence_objects`: an index of what is in the write-once store.
- `webhook_deliveries`: makes redeliveries idempotent.

## Known limits of this MVP build

- One assessment runs at a time (a shared QE environment). A newer push queues behind the running one.
- The Xray cloud adapter and the GitHub-dispatched verifier run are documented interfaces only. The demo uses JUnit files and a local Playwright run.
- `/version` reports a 7-character commit, so the engine compares the short SHA.
- The Jira fixtures hold VP-184 as it is today (5 acceptance criteria), so the assessments of commits 1 and 2 also show 5. In real Jira, the frozen context captures the story as it was at assessment time.
- Sign-in uses demo identities; connect an identity provider for production.
- Simulated prototype workflows (routing missing intent, approving exceptions in-app) are replaced by their real GitHub equivalents, not by new UI.
