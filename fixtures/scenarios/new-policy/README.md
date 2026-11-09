# Scenario: a new policy, and its verifiers generated on the fly

1. Compliance adds `CMP-002` to the policy repository (`CMP-002-bank-change-decisions-justified.yaml`)
   and describes its two checks in `catalog/verifiers.yaml` (`catalog-V5.yaml`).
2. On the next assessment PRCheck.live finds no active verifier for `V5/bank-change-rejection-needs-reason`
   or `V5/bank-change-rejection-reason-recorded`, requests both from the agent core
   (`generated/manifest.yaml`, status `requested`) and marks CMP-002.1 and CMP-002.2 NOT ASSESSED:
   the change is INDETERMINATE, never READY.
3. The agent core (here: the files in `agent-core/`) writes the checks into `generated/` with its fault
   proof and marks them `generated`.
4. An Assurance Lead proves them (three passes on QE) and approves them after reading the code.
   They move into `verifiers/` and count from the next assessment.
