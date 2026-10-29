-- QIVVRA evidence index. The evidence itself lives in the write-once store;
-- these tables hold what was decided, from what, and the digests that prove it.

CREATE TABLE assessments (
  id                TEXT PRIMARY KEY,                 -- ASM-<n>
  repository        TEXT NOT NULL,
  pr_number         INTEGER NOT NULL,
  head_sha          TEXT NOT NULL,
  base_ref          TEXT NOT NULL,
  head_ref          TEXT,
  title             TEXT,
  jira_key          TEXT,
  status            TEXT NOT NULL CHECK (status IN ('queued', 'gathering', 'awaiting_environment', 'verifying', 'deciding', 'done', 'failed')),
  disposition       TEXT CHECK (disposition IN ('READY', 'READY_WITH_EXCEPTIONS', 'NOT_READY', 'INDETERMINATE', 'AWAITING_ASSESSMENT')),
  context_digest    TEXT,                             -- sha256 of the frozen context
  evidence_digest   TEXT,                             -- sha256 of the verifier evidence
  report_digest     TEXT,
  summary           JSONB NOT NULL DEFAULT '{}'::jsonb,
  error             TEXT,
  triggered_by      TEXT NOT NULL,                    -- webhook delivery id, or cli
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);
CREATE INDEX assessments_pr ON assessments (repository, pr_number, created_at DESC);
CREATE SEQUENCE assessment_seq START 1001;

CREATE TABLE obligation_results (
  assessment_id  TEXT NOT NULL REFERENCES assessments(id),
  obligation_id  TEXT NOT NULL,
  policy_id      TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  authority      TEXT NOT NULL,
  severity       TEXT NOT NULL,
  statement      TEXT NOT NULL,
  evidence_check TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('SUPPORTED', 'VIOLATED', 'INSUFFICIENT', 'CONFLICTED', 'NOT_ASSESSED')),
  reason         TEXT,
  excepted_by    TEXT,
  PRIMARY KEY (assessment_id, obligation_id)
);

CREATE TABLE evidence_objects (
  digest      TEXT PRIMARY KEY,                       -- sha256:<hex>
  kind        TEXT NOT NULL,                          -- context | evidence | report
  path        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assessment_events (
  id             BIGSERIAL PRIMARY KEY,
  assessment_id  TEXT NOT NULL REFERENCES assessments(id),
  step           TEXT NOT NULL,
  message        TEXT NOT NULL,
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assessment_events_by_assessment ON assessment_events (assessment_id, id);

CREATE TABLE webhook_deliveries (
  delivery_id  TEXT PRIMARY KEY,                      -- X-GitHub-Delivery, makes redelivery idempotent
  event        TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
