-- Applications onboarded by an Admin in the UI. Applications in prcheck.config.yaml
-- still work; these are added to them at start-up and whenever an Admin saves one.

CREATE TABLE applications (
  key         TEXT PRIMARY KEY,                       -- the repository key in the policy repo's catalog
  name        TEXT NOT NULL,
  config      JSONB NOT NULL,                         -- everything except secrets
  secrets     TEXT,                                   -- AES-256-GCM, see src/secrets.ts; never returned by the API
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who changed the platform's configuration, and when. Append-only.
CREATE TABLE platform_audit (
  id      BIGSERIAL PRIMARY KEY,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT NOT NULL,
  data    JSONB NOT NULL DEFAULT '{}'::jsonb,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
