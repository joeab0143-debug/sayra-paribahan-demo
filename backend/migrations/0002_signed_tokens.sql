-- Tokens are now signed (HMAC) and carry company, role and device id,
-- so the API no longer looks a token up in the database on every request.
-- The devices table only records who has a token, so a device can be revoked.
DROP TABLE IF EXISTS devices;
CREATE TABLE devices (
  id         TEXT PRIMARY KEY,               -- device id written inside the token
  company_id TEXT NOT NULL REFERENCES companies(id),
  role       TEXT NOT NULL CHECK (role IN ('supervisor','counter','admin')),
  user_name  TEXT,
  active     INTEGER NOT NULL DEFAULT 1,     -- set to 0 to revoke; takes effect within a minute
  created_at INTEGER NOT NULL
);
CREATE INDEX devices_inactive ON devices(active) WHERE active = 0;
