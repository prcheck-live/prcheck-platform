-- Functional lane: one row per acceptance criterion of the linked story, per assessment.
-- The checks behind each criterion come from a frozen, approved suite (agent core output).

CREATE TABLE criterion_results (
  assessment_id  TEXT NOT NULL REFERENCES assessments(id),
  criterion_id   TEXT NOT NULL,                       -- <story>-AC<n>, e.g. VP-184-AC5
  story          TEXT NOT NULL,
  position       INTEGER NOT NULL,
  text           TEXT NOT NULL,
  text_digest    TEXT NOT NULL,                       -- of the criterion text frozen in the context
  suite_status   TEXT NOT NULL CHECK (suite_status IN ('approved', 'proven', 'generated', 'stale', 'none')),
  checks         TEXT[] NOT NULL DEFAULT '{}',
  state          TEXT NOT NULL CHECK (state IN ('SUPPORTED', 'FAILED', 'NOT_ASSESSED', 'INCONCLUSIVE')),
  reason         TEXT,
  PRIMARY KEY (assessment_id, criterion_id)
);

ALTER TABLE assessments ADD COLUMN functional_digest TEXT;
-- Per-lane outcome and the evidence classes the profile required: the "nothing pending" record.
ALTER TABLE assessments ADD COLUMN lanes JSONB NOT NULL DEFAULT '{}'::jsonb;
