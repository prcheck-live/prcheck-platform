-- Imported evidence: results from other tools the profile requires (security scan, dependency audit,
-- performance budget), sealed and judged against their gates, per assessment.
CREATE TABLE imported_results (
  assessment_id  TEXT NOT NULL REFERENCES assessments(id),
  import_id      TEXT NOT NULL,
  title          TEXT NOT NULL,
  format         TEXT NOT NULL,
  owner          TEXT,
  state          TEXT NOT NULL CHECK (state IN ('SUPPORTED', 'FAILED', 'NOT_ASSESSED')),
  summary        TEXT NOT NULL,
  gate           JSONB NOT NULL DEFAULT '{}'::jsonb,
  measured       JSONB,
  findings       JSONB NOT NULL DEFAULT '[]'::jsonb,
  digest         TEXT,
  reason         TEXT,
  PRIMARY KEY (assessment_id, import_id)
);
