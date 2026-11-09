-- Work sent to the agent core: impact analysis, verifiers for new rules, story suites.
-- Deliveries are written to the verifiers or suites repository as commits by the agent core,
-- with status "generated": nothing they contain counts until proven and approved.
CREATE TABLE agent_missions (
  id              BIGSERIAL PRIMARY KEY,
  application     TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('impact', 'verifier', 'suite')),
  subject         TEXT NOT NULL,                  -- V5/check, VP-184-AC3, or the commit for impact
  core_mission_id TEXT,
  status          TEXT NOT NULL CHECK (status IN ('queued', 'running', 'delivered', 'applied', 'failed')),
  core_version    TEXT,
  agents          TEXT[] NOT NULL DEFAULT '{}',
  requested_by    TEXT NOT NULL,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  commit_sha      TEXT,
  error           TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX agent_missions_open ON agent_missions (application, subject) WHERE status IN ('queued', 'running', 'delivered');
