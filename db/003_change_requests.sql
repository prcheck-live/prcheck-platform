-- What people ask about a change: a Contributor requests a re-run, acknowledges a
-- finding or disputes a check; the Assurance Lead resolves it. None of these can
-- change a verdict, a rule or a check. They make the conversation visible.

CREATE TABLE change_requests (
  id             BIGSERIAL PRIMARY KEY,
  repository     TEXT NOT NULL,
  pr_number      INTEGER NOT NULL,
  head_sha       TEXT NOT NULL,                 -- the revision it is about
  assessment_id  TEXT NOT NULL REFERENCES assessments(id),
  obligation_id  TEXT,                          -- for acknowledge and dispute
  kind           TEXT NOT NULL CHECK (kind IN ('rerun', 'acknowledge', 'dispute')),
  note           TEXT,
  eta            DATE,                          -- acknowledge: when a fix is expected
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'upheld', 'check_changed')),
  created_by     TEXT NOT NULL,
  created_name   TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by    TEXT,
  resolved_name  TEXT,
  resolved_at    TIMESTAMPTZ,
  resolution     TEXT
);
CREATE INDEX change_requests_by_pr ON change_requests (repository, pr_number, created_at);
