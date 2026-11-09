-- Trust graduation of agent-generated checks: every proof, approval and return, by whom.
-- The decision itself is also a commit in the verifiers or suites repository.
CREATE TABLE suite_reviews (
  id           BIGSERIAL PRIMARY KEY,
  application  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('verifier', 'criterion')),
  subject      TEXT NOT NULL,                 -- V5/check-name, or VP-184-AC3
  action       TEXT NOT NULL CHECK (action IN ('prove', 'approve', 'return')),
  result       TEXT NOT NULL,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  by_email     TEXT NOT NULL,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX suite_reviews_by_subject ON suite_reviews (application, subject, id DESC);

ALTER TABLE criterion_results DROP CONSTRAINT criterion_results_suite_status_check;
ALTER TABLE criterion_results ADD CONSTRAINT criterion_results_suite_status_check
  CHECK (suite_status IN ('approved', 'proven', 'generated', 'returned', 'stale', 'none'));
