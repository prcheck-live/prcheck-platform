-- People who use PRCheck.live, managed by the Platform Admin (Integrations → Members).
-- Each member has one system role, optional Authority tags, and the applications
-- they work on. In production, sign-in comes from the identity provider (SSO);
-- membership, role and applications stay here.

CREATE TABLE members (
  email          TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  designation    TEXT NOT NULL,                 -- e.g. "Finance Controller"
  sys_role       TEXT NOT NULL CHECK (sys_role IN ('Admin', 'Assurance Lead', 'Contributor', 'Viewer')),
  authorities    TEXT[] NOT NULL DEFAULT '{}',  -- Finance, Security, Compliance, Platform
  all_apps       BOOLEAN NOT NULL DEFAULT false,-- every application, including ones onboarded later
  apps           TEXT[] NOT NULL DEFAULT '{}',  -- application keys
  password_hash  TEXT NOT NULL,                 -- scrypt; demo sign-in until SSO is connected
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sign_in   TIMESTAMPTZ
);
