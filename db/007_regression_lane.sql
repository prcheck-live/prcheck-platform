-- Regression lane: earlier stories selected by change impact, re-verified on the same QE build.
CREATE TABLE regression_results (
  assessment_id  TEXT NOT NULL REFERENCES assessments(id),
  criterion_id   TEXT NOT NULL,                 -- <story>-AC<n> of an earlier story
  story          TEXT NOT NULL,
  position       INTEGER NOT NULL,
  text           TEXT NOT NULL,
  suite_status   TEXT NOT NULL,
  checks         TEXT[] NOT NULL DEFAULT '{}',
  state          TEXT NOT NULL CHECK (state IN ('SUPPORTED', 'FAILED', 'NOT_ASSESSED', 'INCONCLUSIVE')),
  reason         TEXT,
  selected_because TEXT NOT NULL,
  PRIMARY KEY (assessment_id, criterion_id)
);
ALTER TABLE assessments ADD COLUMN regression_digest TEXT;
