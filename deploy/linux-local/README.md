# Run the live QIVVRA demo on one Linux machine

Everything runs on one Linux machine (Ubuntu 22.04/24.04 or Debian 12). GitHub is real, and a free Cloudflare tunnel lets GitHub reach the engine. The client watches a real PR get **NOT READY**, **NOT READY**, then **READY** as you push three commits.

```
                         GitHub (your org)
   vendorpay-app ── PR ──┬── pull_request webhook ──────────────┐
                         └── Actions job → self-hosted runner   │
                                                                ▼
 ┌──────────────── your Linux machine ─────────────────────────────────────┐
 │  Actions runner ──qe-deploy.sh──▶ QE: VendorPay :3000 (PR head commit)  │
 │                    └─ team tests ─▶ ~/qivvra/team-results/<sha>/        │
 │  cloudflared tunnel ─▶ QIVVRA engine :4000 ──verifiers──▶ QE :3000      │
 │                          └─ status + PR comment ──▶ GitHub              │
 │  PostgreSQL :5432 (vendorpay, qivvra)                                   │
 └─────────────────────────────────────────────────────────────────────────┘
```

## What you need

| | |
|---|---|
| Machine | Linux, 2 CPU / 4 GB RAM / 10 GB disk, internet access, `sudo` |
| GitHub | An organisation you own, for example `ascendqe-demo` (github.com → Your organizations → New organization → Free) |
| GitHub CLI | `gh auth login` as the org owner, on the machine |
| Token | A fine-grained personal access token for the engine (step 2) |

Repos are created **public**. On the free plan, branch protection (the merge gate) only works on public repos. Use a paid plan if they must be private (`VISIBILITY=private`).

## Step 1: push the repos (once)

On the machine, unzip `qivvra-all-repos.zip`, then from that folder:

```bash
GH_ORG=ascendqe-demo qivvra-platform/deploy/linux-local/push-to-github.sh
```

This creates `vendorpay-app`, `vendorpay-policies`, `qivvra-verifiers` and `qivvra-platform` in your org and pushes them. It pushes PR #482's branch at **commit 1 only**, creates the CODEOWNERS teams, and repoints policy owners at `@<your-org>/…`.

## Step 2: token and secrets (once)

1. github.com → Settings → Developer settings → **Fine-grained tokens** → Generate new token.
   - Resource owner: your org. Repository access: only `vendorpay-app`.
   - Repository permissions: **Commit statuses: Read and write**, **Pull requests: Read and write**, **Issues: Read and write**, Contents: Read-only.
   - If the org requires approval for fine-grained tokens, approve it under Org settings → Personal access tokens.
2. Create the env file:

```bash
mkdir -p ~/qivvra && cp qivvra-platform/deploy/linux-local/qivvra.env.example ~/qivvra/qivvra.env
nano ~/qivvra/qivvra.env      # GH_ORG, QIVVRA_GITHUB_TOKEN, WEBHOOK_SECRET (openssl rand -hex 32)
```

## Step 3: set up the machine (once)

```bash
qivvra-platform/deploy/linux-local/setup.sh --install
```

This installs Node 22, PostgreSQL, cloudflared and gh if they're missing, and creates the `vendorpay` and `qivvra` databases. It clones the repos into `~/qivvra/repos`, installs dependencies and Chromium, validates the policies, writes `~/qivvra/qivvra.config.yaml`, and deploys VendorPay `main` to QE as a first test.

From now on, use the scripts in `~/qivvra/repos/qivvra-platform/deploy/linux-local/`:

```bash
cd ~/qivvra/repos/qivvra-platform/deploy/linux-local
./register-runner.sh      # registers this machine as the Actions runner "qivvra-qe" for vendorpay-app
```

## Step 4: start (every time)

```bash
./start.sh
```

This starts the tunnel, prints its public URL, starts the engine and the runner, and then runs `configure-github.sh`. That script:
- points the `vendorpay-app` webhook at the new tunnel URL (it changes on every start);
- makes **`qivvra/assurance` a required check** on `vendorpay-app` main;
- requires validation and a **code-owner approval** on `vendorpay-policies` main.

Open the printed URL to see the QIVVRA UI: the approved prototype, now on live data. Sign in as `a.rao@qivvra.demo` (password `Qivvra@2026`, code `246810`) to drive the demo; the other demo accounts show what each role sees.

## Step 5: the demo

| Run | What the client sees on the PR (about 2 minutes each) |
|---|---|
| `./demo-push.sh 1` | PR opens. "QE (local machine)": team tests ✅ 25/25. **qivvra/assurance ❌ NOT READY**: FIN-001.1, FIN-002.1, FIN-002.3. Merge is blocked. |
| `./demo-push.sh 2` | The team fixed self-approval. Team tests ✅ 26/26. **❌ NOT READY**: FIN-002.1, FIN-002.3. The PR comment updates in place. |
| `./demo-push.sh 3` | Scheduled payments are held. Team tests ✅ 29/29. **✅ READY**. Merge unblocked. |
| `./demo-push.sh reset` | Back to commit 1 for another run. |

Each push makes the runner deploy that exact commit to QE and run the team's tests. GitHub sends the webhook, and QIVVRA waits until QE reports the commit and the team's results exist. It then runs its own checks and posts the verdict. Click **Details** next to `qivvra/assurance` to open the assessment.

The PR number is whatever GitHub assigns (likely #1), not #482.

Talking points:
- The team's checks are green on all three commits; only QIVVRA tells them apart.
- Commit 2 is the moment that sells it: the team fixed the bug they knew about, and QIVVRA still blocks the one the story never mentioned.
- In the PR comment, every blocker names its policy owner (`@<org>/finance-controls`) and the evidence.
- In the QIVVRA UI, open **Revisions** for the commit-by-commit comparison, **Evidence** for the verifier's observation (for example PAY-xxxx still `scheduled` and released with HTTP 200), and the **Assurance case** for sealed proof. Editing a stored object by hand makes the engine refuse to serve it.
- Sign in as `r.das` (Contributor), `m.iyer` (Finance authority) or `p.nair` (Admin) to show that roles are enforced by the server, not just hidden in the menu.
- Sign in as `p.nair` (Admin) → **Integrations → Add application** to show onboarding: every step's **Test connection** tries the real system (GitHub, Jira, the policy repo's validator, the verifiers' coverage of every obligation, QE `/version`). VendorPay is already defined in `qivvra.config.yaml`, so the wizard refuses the key `vendorpay`; a second application needs its key registered in the policy repository's `catalog/components.yaml` first.

## Stop

```bash
./stop.sh
```

## Where things are on the machine

| Path | What |
|---|---|
| `~/qivvra/qivvra.env` | Secrets and org name |
| `~/qivvra/qivvra.config.yaml` | Engine configuration |
| `~/qivvra/repos/` | Clones of the policy, verifier and engine repos |
| `~/qivvra/qe/current` | The VendorPay build QE is running; `qe/app.log` is its log |
| `~/qivvra/team-results/<sha>/junit.xml` | Team results per commit |
| `~/qivvra/data/evidence/` | Write-once evidence store |
| `~/qivvra/data/outbox/` | Only used if the token is missing |
| `~/qivvra/logs/` | engine.log, tunnel.log, runner.log |
| `~/qivvra/actions-runner/` | The self-hosted runner |

## Troubleshooting

| Symptom | Check |
|---|---|
| No `QE (local machine)` run on the PR | Is the runner online? Repo → Settings → Actions → Runners. Check `logs/runner.log`. |
| `qivvra/assurance` never appears | Repo → Settings → Webhooks → Recent deliveries. A 401 means `WEBHOOK_SECRET` doesn't match. A connection error means the tunnel restarted, so rerun `./start.sh`. |
| Stays "pending" | `logs/engine.log`. The engine waits up to 15 minutes for QE to run the commit and 10 minutes for team results. |
| INDETERMINATE | QE was not running the PR's commit (V1). Look at the runner job's log. |
| Chromium won't start | `cd ~/qivvra/repos/qivvra-verifiers && sudo npx playwright install-deps chromium` |
| Status not posted, files in `data/outbox/` | `QIVVRA_GITHUB_TOKEN` is missing or lacks Commit statuses / Pull requests permissions |

## Safety

- The runner executes code from PR branches on your machine. `qe-local.yml` refuses PRs from forks, and `register-runner.sh` turns on approval for external contributors. Only add people you trust to the org.
- The quick tunnel URL is public but random, and the webhook endpoint rejects anything without the right signature. The UI requires sign-in, but the accounts are demo identities with a published password, so don't share the URL beyond the demo.
