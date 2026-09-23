import type { Backend, Env, Instance } from './env.ts';
import { tunnelName } from './session.ts';

export type State = 'starting' | 'ready' | 'stopping' | 'ended' | 'failed';

export interface Row {
  id: string;
  email: string;
  username: string;
  region: string;
  resume_key: string | null;
  hostname: string;
  state: State;
  tunnel_id: string | null;
  instance_id: string | null;
  error: string | null;
  created_at: number;
  ready_at: number | null;
  stop_requested_at: number | null;
  ended_at: number | null;
}

const MIN = 60_000;
const LAUNCH_GRACE = 3 * MIN;   // DescribeInstances can lag RunInstances by a while
const BOOT_TIMEOUT = 20 * MIN;
const STOP_TIMEOUT = 30 * MIN;  // a full-size final save takes minutes, not half an hour

export async function liveSession(db: D1Database, email: string): Promise<Row | null> {
  return db.prepare('SELECT * FROM sessions WHERE email = ? AND ended_at IS NULL').bind(email).first<Row>();
}

export async function update(db: D1Database, id: string, fields: Partial<Row>): Promise<void> {
  const keys = Object.keys(fields);   // column names come from code, never from requests
  await db.prepare(`UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k as keyof Row] ?? null), id)
    .run();
}

/** Remove the session's tunnel and DNS record, then close the row. */
export async function finish(env: Env, b: Backend, row: Row, state: 'ended' | 'failed', error: string | null): Promise<Row> {
  await b.tunnels.remove(tunnelName(row.id), row.hostname);
  const ended_at = Date.now();
  await update(env.DB, row.id, { state, error, ended_at });
  return { ...row, state, error, ended_at };
}

/** Bring a live row up to date with its instance (undefined if gone) and tunnel. */
export async function refresh(env: Env, b: Backend, row: Row, instance: Instance | undefined, now = Date.now()): Promise<Row> {
  if (!instance) {
    if (row.state === 'starting' && now - row.created_at < LAUNCH_GRACE) return row;
    return row.state === 'starting'
      ? finish(env, b, row, 'failed', 'The desktop shut down before it was ready. Check that the region\'s images are in S3.')
      : finish(env, b, row, 'ended', null);
  }
  if (row.state === 'starting' && row.tunnel_id && await b.tunnels.healthy(row.tunnel_id)) {
    await update(env.DB, row.id, { state: 'ready', ready_at: now });
    return { ...row, state: 'ready', ready_at: now };
  }
  return row;
}

/**
 * Cron: settle every live session, and terminate instances no session owns.
 * It is the backstop for everything the request path can miss: a closed tab,
 * napari closed from inside the desktop, a failed boot, a half-made launch.
 */
export async function reap(env: Env, b: Backend, now = Date.now()): Promise<void> {
  // Instances first: a row is always inserted before its instance is
  // launched, so any instance seen here already has its row below.
  const instances = await b.cloud.instances();
  const live = (await env.DB.prepare('SELECT * FROM sessions WHERE ended_at IS NULL').all<Row>()).results;

  const liveIds = new Set(live.map((r) => r.id));
  const orphans = instances.filter((i) => !liveIds.has(i.session)).map((i) => i.id);
  if (orphans.length) {
    console.log(`reaper: terminating instances with no live session: ${orphans.join(', ')}`);
    await b.cloud.terminate(orphans);
  }

  const bySession = new Map(instances.map((i) => [i.session, i]));
  for (const row of live) {
    const instance = bySession.get(row.id);
    try {
      if (instance && row.state === 'starting' && now - row.created_at > BOOT_TIMEOUT) {
        await b.cloud.terminate([instance.id]);
        await finish(env, b, row, 'failed', 'The desktop did not come up within 20 minutes.');
      } else if (instance && row.state === 'stopping' && now - (row.stop_requested_at ?? now) > STOP_TIMEOUT) {
        console.log(`reaper: session ${row.id} did not shut itself down; terminating ${instance.id}`);
        await b.cloud.terminate([instance.id]);   // the next run closes the row once it is gone
      } else {
        await refresh(env, b, row, instance, now);
      }
    } catch (err) {
      console.error(`reaper: session ${row.id}:`, err);   // retried on the next run
    }
  }
}
