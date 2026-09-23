-- One row per desktop session. A row is live until ended_at is set.
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,   -- 10 random base32 characters; also in the hostname
  email             TEXT NOT NULL,
  username          TEXT NOT NULL,      -- $USER on the desktop, so it names the masks
  region            TEXT NOT NULL,
  resume_key        TEXT,               -- S3 key of the masks file resumed from
  hostname          TEXT NOT NULL,
  state             TEXT NOT NULL,      -- starting | ready | stopping | ended | failed
  tunnel_id         TEXT,
  instance_id       TEXT,
  error             TEXT,
  created_at        INTEGER NOT NULL,   -- ms since epoch
  ready_at          INTEGER,
  stop_requested_at INTEGER,
  ended_at          INTEGER
);

-- A second Start (double click, second tab) fails here instead of launching twice.
CREATE UNIQUE INDEX one_live_session_per_user ON sessions (email) WHERE ended_at IS NULL;
