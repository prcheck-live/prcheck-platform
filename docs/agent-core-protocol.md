# PRCheck.live agent-core protocol, `prcheck.agent-core/v1`

This is the contract between PRCheck.live and the myDiya agent core. PRCheck.live sends the core **missions**; the core's agents do the work and deliver files. The core never sees evidence or verdicts, and never decides anything: everything it delivers is *generated* and counts only after PRCheck.live proves it and an Assurance Lead approves it.

`reference-core/server.mjs` implements this protocol (a contract test double with a small pattern library). The myDiya agent core implements the same endpoints with its agents.

## Transport

- HTTPS, JSON bodies. Every request carries `Authorization: Bearer <token>`; the token is set per application in PRCheck.live (stored encrypted) or, for applications in `prcheck.config.yaml`, in `PRCHECK_AGENT_CORE_TOKEN`.
- Missions are asynchronous: `POST` returns at once; PRCheck.live polls `GET /v1/missions/{id}` about once a second.
- A core must answer 401 to a wrong token, and 400 to an unknown `kind` or `protocol`.

## `GET /v1/info`

```json
{ "name": "mydiya-agent-core", "version": "0.2.0", "protocol": "prcheck.agent-core/v1",
  "missions": ["impact", "verifier", "suite"], "agents": ["myClara", "myDelta", "myTessa", "myGenie", "myNexa"] }
```

PRCheck.live refuses a core whose `protocol` differs, or whose `version` does not start with the version the application pins (`agent_core.version`). Pinning means a new core release cannot change what gets generated until the Admin upgrades.

## `POST /v1/missions`

```json
{ "protocol": "prcheck.agent-core/v1", "kind": "verifier", "payload": { } }
```
→ `202 { "id": "M-2041", "status": "queued" }`

## `GET /v1/missions/{id}`

```json
{ "id": "M-2041", "kind": "verifier", "status": "delivered",
  "agents": ["myClara", "myTessa", "myGenie", "myNexa"], "core": { "name": "mydiya-agent-core", "version": "0.2.0" },
  "submittedAt": "…", "finishedAt": "…", "result": { } }
```

`status`: `queued` → `running` → `delivered` | `failed` (with `"error": "<why, in words>"`). A core that cannot do a mission says so with `failed`; it never delivers a guess.

## Mission kinds

### `impact` (myDelta): which earlier stories can this change affect?

Payload:
```json
{ "application": "vendorpay", "sha": "38e8b97…",
  "changedFiles": ["src/routes/payments.ts", "db/migrations/003_payment_holds.sql"],
  "components": { "payments": ["src/routes/payments.ts", "db/migrations/**"], "audit": ["src/audit.ts"] },
  "stories": [{ "key": "VP-183", "components": ["payments"] }, { "key": "VP-185", "components": ["audit", "payments"] }] }
```
Result:
```json
{ "selected": [{ "story": "VP-183", "because": "myDelta: …", "confidence": "high" }],
  "changedComponents": ["payments"], "unknownFiles": [], "confidence": "high" }
```
PRCheck.live merges the answer into its own component-overlap selection: myDelta can **add** stories (its reason is shown), never remove one. If the core is down or slow (60 s), the component-overlap selection stands and the assessment says so.

### `verifier`: a check for a rule no active verifier covers

Sent when an obligation in the policy repository names a check that no verifier defines, and again when a Lead returns a delivered verifier.

Payload:
```json
{ "application": "vendorpay", "obligation": "CMP-002.1", "policy": "CMP-002", "check": "V5/bank-change-rejection-needs-reason",
  "expectation": "Rejecting a bank change without a reason gets 422 and leaves the request open.",
  "qeUrl": "http://qe…", "channels": { "ui": { … }, "api": { … }, "mcp": { … } },
  "identities": ["VP_PROCUREMENT", "VP_APPROVER_A", "…"], "feedback": null }
```
`expectation` is the check's description from the policy repository's `catalog/verifiers.yaml`. `identities` are names only; values never leave PRCheck.live. `feedback` is the Lead's note when the verifier was returned.

Result:
```json
{ "files": [{ "path": "generated/V5-bank-change-decisions.spec.ts", "content": "…" }],
  "entries": [{ "check": "V5/bank-change-rejection-needs-reason", "file": "generated/V5-bank-change-decisions.spec.ts",
                "fault": { "seeded": "reject accepts an empty reason (validation removed)", "result": "FAILED", "by": "myGenie" } }] }
```
- Files go only under `generated/`; anything else is refused.
- Each test is titled exactly with its check (`V5/bank-change-rejection-needs-reason`), attaches an `observation`, and puts data setup in `arrange:` steps (an arrange failure is *not assessed*, never a violation).
- `fault` is required: proof that the check fails on a build with a seeded fault. Without it PRCheck.live will not mark the check proven.

### `suite`: checks for a story's acceptance criteria

Sent when a linked story has criteria with no checks or stale ones (the criterion's text changed after approval), and when a Lead returns a criterion's checks.

Payload:
```json
{ "application": "vendorpay", "story": "VP-184", "criteria": ["AC3"],
  "texts": { "AC3": "The new account number is masked in the UI and API." },
  "spec": { "path": "functional/VP-184.spec.ts", "content": "<the current spec file>" },
  "qeUrl": "…", "channels": { … }, "identities": ["…"], "feedback": "Also check the supplier list response" }
```
Result:
```json
{ "files": [{ "path": "functional/VP-184.spec.ts", "content": "<the whole spec file>" }],
  "criteria": [{ "id": "AC3", "checks": ["F-VP184/AC3-new-account-masked"],
                 "fault": { "seeded": "new account number returned unmasked", "result": "FAILED", "by": "myGenie" },
                 "note": "Regenerated after review: …" }] }
```
Spec files go only under `functional/`. Checks are titled `F-<story>/<AC>-<name>`.

## What PRCheck.live does with a delivery

1. Writes the files and the manifest entries (`generated/manifest.yaml` or `functional/suites/<story>.yaml`) with status **generated**, the core version, agents and mission id.
2. Commits them to the verifiers or suites repository as **myDiya agent core**, citing the mission.
3. Shows them on **Generated checks**. The Lead proves (three passes on QE, plus the core's fault proof), reads the code, and approves or returns them. Approval is a commit by the Lead.
4. Until approved, the rule or criterion is NOT ASSESSED and no change it applies to can be READY.

PRCheck.live records every mission in `agent_missions` (kind, subject, status, core version, agents, the commit it produced, or the error), and resumes following open missions after a restart.
