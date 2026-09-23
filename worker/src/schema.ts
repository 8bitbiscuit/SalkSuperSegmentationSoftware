// The Worker makes its own tables, so a fresh deploy needs no setup step.
// Every statement is safe to run again.

export const SCHEMA = [
  // One row per desktop session. A row is live until ended_at is set.
  `CREATE TABLE IF NOT EXISTS sessions (
    id                TEXT PRIMARY KEY,   -- 10 random base32 characters; also in the hostname
    email             TEXT NOT NULL,
    username          TEXT NOT NULL,      -- $USER on the desktop, so it names the masks
    region            TEXT NOT NULL,      -- the folder opened, under the data prefix
    resume_key        TEXT,               -- S3 key of the masks file resumed from
    hostname          TEXT NOT NULL,
    state             TEXT NOT NULL,      -- starting | ready | stopping | ended | failed
    tunnel_id         TEXT,
    instance_id       TEXT,
    error             TEXT,
    created_at        INTEGER NOT NULL,   -- ms since epoch
    ready_at          INTEGER,
    stop_requested_at INTEGER,
    ended_at          INTEGER,
    login_id          TEXT                -- the sign-in whose tokens the desktop uses
  )`,
  // A second Start (double click, second tab) fails here instead of launching twice.
  `CREATE UNIQUE INDEX IF NOT EXISTS one_live_session_per_user ON sessions (email) WHERE ended_at IS NULL`,
  // One row per Cognito sign-in. The cookie holds the id.
  `CREATE TABLE IF NOT EXISTS logins (
    id                  TEXT PRIMARY KEY,
    email               TEXT NOT NULL,
    refresh_token       TEXT NOT NULL,
    id_token            TEXT NOT NULL,
    id_token_expires_at INTEGER NOT NULL,
    created_at          INTEGER NOT NULL,
    signed_out_at       INTEGER
  )`,
  // Values the Worker makes for itself, such as the desktop token key.
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

const ready = new WeakMap<D1Database, Promise<unknown>>();

/** Create the tables once per database per Worker instance. */
export function ensureSchema(db: D1Database): Promise<unknown> {
  let p = ready.get(db);
  if (!p) {
    p = db.batch(SCHEMA.map((sql) => db.prepare(sql)));
    p.catch(() => ready.delete(db));   // try again on the next request
    ready.set(db, p);
  }
  return p;
}

const secrets = new WeakMap<D1Database, Promise<string>>();

/** A random key made on first use and kept in the database: signs desktop tokens. */
export function desktopSecret(db: D1Database): Promise<string> {
  let p = secrets.get(db);
  if (!p) {
    const fresh = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    p = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('desktop_secret', ?)").bind(fresh).run()
      .then(() => db.prepare("SELECT value FROM settings WHERE key = 'desktop_secret'").first<{ value: string }>())
      .then((row) => row!.value);
    p.catch(() => secrets.delete(db));
    secrets.set(db, p);
  }
  return p;
}
