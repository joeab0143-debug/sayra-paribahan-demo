-- Live bus location: cheap design (D1 + polling)
-- Every row carries company_id. Queries always take company_id from the
-- caller's token, never from the request, so one company can never read another's data.

CREATE TABLE companies (
  id         TEXT PRIMARY KEY,              -- e.g. 'sayra'
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' -- 'active' | 'suspended'
);

-- One row per logged-in device/user. Only the SHA-256 hash of the token is stored.
CREATE TABLE devices (
  token_hash TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  role       TEXT NOT NULL CHECK (role IN ('supervisor','counter','admin')),
  user_name  TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Trips that may report a location (created by the ticketing side of the system).
CREATE TABLE trips (
  id         TEXT PRIMARY KEY,              -- e.g. 'sayra|2026-11-06|u0630'
  company_id TEXT NOT NULL REFERENCES companies(id),
  bus_code   TEXT,
  route_id   TEXT,
  dep_at     INTEGER
);
CREATE INDEX trips_company ON trips(company_id);

-- Exactly one row per running trip: the latest position.
-- A ping updates lat/lng/... only; company_id is never rewritten,
-- so the index below costs nothing on each ping.
CREATE TABLE live_positions (
  trip_id     TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  speed       REAL,                         -- km/h
  heading     REAL,
  recorded_at INTEGER NOT NULL,             -- when the phone took the fix (ms)
  received_at INTEGER NOT NULL,             -- when the server got it (ms)
  hist_at     INTEGER NOT NULL DEFAULT 0,   -- last time a history row was written
  shared      INTEGER NOT NULL DEFAULT 1    -- supervisor turned sharing on/off
);
CREATE INDEX live_company ON live_positions(company_id);

-- Track history, at most one row per trip per minute. Old rows are deleted daily.
CREATE TABLE position_history (
  trip_id     TEXT NOT NULL,
  company_id  TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  speed       REAL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (trip_id, recorded_at)
) WITHOUT ROWID;
