import { LOGIN_HOURS } from './auth.ts';
import type { Backend, Env, Instance, Tunnels } from './env.ts';
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
  login_id: string | null;   // the sign-in whose tokens the desktop uses
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
export async function finish(env: Env, tunnels: Tunnels, row: Row, state: 'ended' | 'failed', error: string | null): Promise<Row> {
  await tunnels.remove(tunnelName(row.id), row.hostname);
  const ended_at = Date.now();
  await update(env.DB, row.id, { state, error, ended_at });
  return { ...row, state, error, ended_at };
}

/** Bring a live row up to date with its instance (undefined if gone) and tunnel. */
export async function refresh(env: Env, b: Backend, row: Row, instance: Instance | undefined, now = Date.now()): Promise<Row> {
  if (!instance) {
    if (row.state === 'starting' && now - row.created_at < LAUNCH_GRACE) return row;
    return row.state === 'starting'
      ? finish(env, b.tunnels, row, 'failed', 'The desktop shut down before it was ready. Check that the region\'s images are in S3.')
      : finish(env, b.tunnels, row, 'ended', null);
  }
  if (row.state === 'starting' && row.tunnel_id && await b.tunnels.healthy(row.tunnel_id)) {
    await update(env.DB, row.id, { state: 'ready', ready_at: now });
    return { ...row, state: 'ready', ready_at: now };
  }
  return row;
}

/**
 * Cron: settle every live session. It is the backstop for everything the
 * request path can miss: a closed tab, napari closed inside the desktop, a
 * failed boot, a desktop that ignored End session.
 *
 * It holds no AWS keys of its own: `asOwner` gives it the session owner's
 * credentials, from their sign-in. When those are gone (signed out long ago,
 * sign-in revoked), it goes by the tunnel instead; the desktop itself powers
 * off once nobody has been connected for IDLE_MINUTES.
 */
export async function reap(env: Env, asOwner: (row: Row) => Promise<Backend | null>, tunnels: Tunnels, now = Date.now()): Promise<void> {
  const live = (await env.DB.prepare('SELECT * FROM sessions WHERE ended_at IS NULL').all<Row>()).results;

  for (const row of live) {
    try {
      const b = await asOwner(row);
      if (!b) {
        if (now - row.created_at > BOOT_TIMEOUT && !(row.tunnel_id && await tunnels.healthy(row.tunnel_id))) {
          await finish(env, tunnels, row, row.ready_at ? 'ended' : 'failed', row.ready_at ? null : 'The desktop never came up.');
        }
        continue;
      }
      const [instance] = await b.cloud.instances(row.id);
      if (instance && row.state === 'starting' && now - row.created_at > BOOT_TIMEOUT) {
        await b.cloud.terminate([instance.id]);
        await finish(env, tunnels, row, 'failed', 'The desktop did not come up within 20 minutes.');
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

  // Sign-ins nobody can use any more, unless a running desktop still saves with them.
  await env.DB.prepare(`DELETE FROM logins WHERE (signed_out_at IS NOT NULL OR created_at < ?)
                        AND id NOT IN (SELECT login_id FROM sessions WHERE ended_at IS NULL AND login_id IS NOT NULL)`)
    .bind(now - LOGIN_HOURS * 3_600_000).run();
}
