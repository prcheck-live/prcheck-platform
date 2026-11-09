<!-- prcheck-assessment -->
## PRCheck.live: NOT READY

Commit `900652c` · VP-184 "Let Procurement change a supplier's bank account" (5 acceptance criteria)

Team tests on this commit: **26/26 passed** (VP-184: 6/6). PRCheck.live assessed **14 obligations** from the policy repository: 12 supported, 2 open.

### What blocks this change

| | Obligation | Owner | Evidence |
|---|---|---|---|
| ❌ VIOLATED | **FIN-002.1** After a bank change is approved, the supplier's scheduled payments are on hold and cannot be released. | @vendorpay/finance-controls | `V3/scheduled-payments-held`: payment scheduled to the replaced account must be on hold |
| ❌ VIOLATED | **FIN-002.3** Each held payment is visible to Finance with the reason it was held. | @vendorpay/finance-controls | `V3/held-payment-visible`: Finance must see the payment as held |

<details><summary>All obligations</summary>

| | Obligation | Policy | Check |
|---|---|---|---|
| ✅ | CMP-001.1 Each bank account change step (request, approve, reject) writes an audit event with its actor. | CMP-001 v1.0.0 | `V5/bank-change-audited` |
| ✅ | CMP-001.2 Each payment step (schedule, release, hold) writes an audit event with its actor. | CMP-001 v1.0.0 | `V5/payment-steps-audited` |
| ✅ | FIN-001.1 The person who requested a bank account change cannot approve it. | FIN-001 v1.0.0 | `V2/bank-change-self-approval-blocked` |
| ✅ | FIN-001.2 A proposed bank account cannot receive payments before it is approved. | FIN-001 v1.0.0 | `V2/proposed-account-not-payable` |
| ✅ | FIN-001.3 The requester and the approver of every change are recorded. | FIN-001 v1.0.0 | `V5/bank-change-actors-recorded` |
| ❌ | FIN-002.1 After a bank change is approved, the supplier's scheduled payments are on hold and cannot be released. | FIN-002 v1.0.0 | `V3/scheduled-payments-held` |
| ✅ | FIN-002.2 Scheduled payments are never redirected to the new account without a Finance decision. | FIN-002 v1.0.0 | `V3/no-silent-redirect` |
| ❌ | FIN-002.3 Each held payment is visible to Finance with the reason it was held. | FIN-002 v1.0.0 | `V3/held-payment-visible` |
| ✅ | FIN-003.1 The scheduler of a payment cannot release it. | FIN-003 v1.0.0 | `V2/payment-self-release-blocked` |
| ✅ | FIN-003.2 A payment cannot be released twice. | FIN-003 v1.0.0 | `V2/payment-single-release` |
| ✅ | PLT-001.1 The QE environment reports the pull request's head commit at /version before and after verification. | PLT-001 v1.0.0 | `V1/qe-runs-head-commit` |
| ✅ | SEC-001.1 Screens show only the last four digits of any bank account. | SEC-001 v1.1.0 | `V4/ui-masked` |
| ✅ | SEC-001.2 API responses never contain a full bank account number. | SEC-001 v1.1.0 | `V4/api-masked` |
| ✅ | SEC-001.3 Application logs and audit details never contain a full bank account number. | SEC-001 v1.1.0 | `V4/logs-masked` |

</details>

<sub>Assessment [ASM-1002](http://localhost:4000/assessments/ASM-1002) · context `sha256:f04f4ab9b2aa…` · evidence `sha256:2cef50e94e6f…` · policy snapshot `sha256:94871143b1dc…` (policies 770e896, verifiers 69f4c5d)</sub>