import { identify } from './access.ts';
import { awsCloud } from './aws.ts';
import { HttpError, json, type Backend, type Env } from './env.ts';
import { finish, liveSession, reap, refresh, update, type Row } from './lifecycle.ts';
import { mockBackend, mockDesktopPage } from './mock.ts';
import {
  dcvToken, hostnameFor, masksPrefix, newSessionId, parseMasksName, REGION_ID, tunnelName, userData, usernameOf,
} from './session.ts';
import { cloudflareTunnels } from './tunnel.ts';

// The DCV session every desktop runs; the web client's URL fragment names it.
const DCV_SESSION = 'annotate';

function backend(env: Env): Backend {
  if (env.BACKEND === 'mock') return mockBackend;
  return {
    cloud: awsCloud(env),
    tunnels: cloudflareTunnels(env),
    desktopUrl: (hostname, _session, token) =>
      `https://${hostname}/?authToken=${encodeURIComponent(token)}#${DCV_SESSION}`,
  };
}

function tokenSecret(env: Env): string {
  if (env.DCV_TOKEN_SECRET) return env.DCV_TOKEN_SECRET;
  if (env.BACKEND === 'mock') return 'local-development-only';
  throw new Error('Worker is missing the DCV_TOKEN_SECRET secret');
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    try {
      // Browsers always send Origin on cross-site POST/DELETE; refuse those.
      const origin = req.headers.get('origin');
      if (req.method !== 'GET' && origin && origin !== url.origin) {
        throw new HttpError(403, 'Cross-site request refused.');
      }
      const email = await identify(req, env);
      const b = backend(env);

      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/state': return json(await getState(env, b, email));
        case 'GET /api/masks': return json(await listMasks(req, env, b, email, url.searchParams.get('region')));
        case 'POST /api/session': return json(await startSession(req, env, b, email), 202);
        case 'DELETE /api/session': return json(await endSession(env, b, email), 202);
        case 'GET /api/dev/desktop':
          if (env.BACKEND === 'mock') return mockDesktopPage(url);
      }
      throw new HttpError(404, 'No such API route.');
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(reap(env, backend(env)));
  },
} satisfies ExportedHandler<Env>;

// ---- handlers ---------------------------------------------------------------

async function getState(env: Env, b: Backend, email: string) {
  let row = await liveSession(env.DB, email);
  if (row) {
    const [instance] = await b.cloud.instances(row.id);
    row = await refresh(env, b, row, instance);
  }
  const live = row && row.ended_at === null ? row : null;
  const last = live ? null : await env.DB
    .prepare('SELECT * FROM sessions WHERE email = ? AND ended_at > ? ORDER BY ended_at DESC LIMIT 1')
    .bind(email, Date.now() - 15 * 60_000)
    .first<Row>();

  return {
    user: { email, username: usernameOf(email) },
    signout: env.BACKEND === 'mock' ? null : '/cdn-cgi/access/logout',
    session: live ? await view(env, b, live) : null,
    last: last && { region: last.region, state: last.state, error: last.error, ready_at: last.ready_at, ended_at: last.ended_at },
  };
}

async function listMasks(req: Request, env: Env, b: Backend, email: string, region: unknown) {
  const id = await requireRegion(req, env, region);
  const prefix = masksPrefix(id);
  const masks = (await b.cloud.listMasks(id))
    .flatMap((f) => {
      const name = f.key.slice(prefix.length);
      const parsed = f.key.startsWith(prefix) && !name.includes('/') ? parseMasksName(name) : null;
      return parsed ? [{ key: f.key, name, user: parsed.user, saved_at: f.modified, size: f.size }] : [];
    })
    .sort((x, y) => y.saved_at.localeCompare(x.saved_at));
  return { username: usernameOf(email), masks };
}

async function startSession(req: Request, env: Env, b: Backend, email: string) {
  const body = await req.json().catch(() => null) as { region?: unknown; resume_key?: unknown } | null;
  const region = await requireRegion(req, env, body?.region);

  let resume: string | null = null;
  if (body?.resume_key) {
    const key = body.resume_key;
    // Anyone may resume anyone's masks, but only a masks file of this region.
    if (typeof key !== 'string' || !(await b.cloud.listMasks(region)).some((f) => f.key === key)) {
      throw new HttpError(400, 'That masks file is not in this region any more. Reload the page.');
    }
    resume = key;
  }

  const secret = tokenSecret(env);
  const id = newSessionId();
  const row: Row = {
    id, email, username: usernameOf(email), region, resume_key: resume,
    hostname: hostnameFor(env.SESSION_HOSTNAME, id), state: 'starting',
    tunnel_id: null, instance_id: null, error: null,
    created_at: Date.now(), ready_at: null, stop_requested_at: null, ended_at: null,
  };

  try {
    await env.DB.prepare(`INSERT INTO sessions (id, email, username, region, resume_key, hostname, state, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.id, row.email, row.username, row.region, row.resume_key, row.hostname, row.state, row.created_at)
      .run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new HttpError(409, 'You already have a session. Reload the page to see it.');
    throw err;
  }

  try {
    const tunnel = await b.tunnels.create(tunnelName(id), row.hostname);
    row.tunnel_id = tunnel.id;
    await update(env.DB, id, { tunnel_id: tunnel.id });

    row.instance_id = await b.cloud.launch({
      session: id, email, username: row.username, region,
      userData: userData(
        {
          SESSION_ID: id,
          ANNOTATOR: row.username,
          REGION: region,
          RESUME_KEY: resume ?? '',
          BUCKET: env.BUCKET ?? '',
          AWS_REGION: env.AWS_REGION ?? '',
          IDLE_MINUTES: env.IDLE_MINUTES,
        },
        { TUNNEL_TOKEN: tunnel.token, DCV_TOKEN: await dcvToken(secret, id) },
      ),
    });
    await update(env.DB, id, { instance_id: row.instance_id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // If this cleanup fails too, the row stays live and the reaper retries it.
    await finish(env, b, row, 'failed', message).catch((e) => console.error(`cleanup of ${id} failed:`, e));
    throw new HttpError(502, `Could not start the desktop: ${message}`);
  }
  return { session: await view(env, b, row) };
}

async function endSession(env: Env, b: Backend, email: string) {
  const row = await liveSession(env.DB, email);
  if (!row) throw new HttpError(404, 'You have no session running.');
  const [instance] = await b.cloud.instances(row.id);

  if (row.state === 'starting' || !instance) {
    // Never reachable yet, so nothing painted: stop it outright.
    if (instance) await b.cloud.terminate([instance.id]);
    await finish(env, b, row, 'ended', null);
    return { session: null };
  }

  // The instance saves and shuts itself down; the row closes once it's gone.
  await b.cloud.requestStop(instance.id);
  if (row.state !== 'stopping') {
    await update(env.DB, row.id, { state: 'stopping', stop_requested_at: Date.now() });
  }
  return { session: await view(env, b, { ...row, state: 'stopping' }) };
}

// ---- helpers ----------------------------------------------------------------

async function view(env: Env, b: Backend, row: Row) {
  return {
    id: row.id,
    state: row.state,
    region: row.region,
    resume_key: row.resume_key,
    created_at: row.created_at,
    ready_at: row.ready_at,
    url: row.state === 'ready' ? b.desktopUrl(row.hostname, row.id, await dcvToken(tokenSecret(env), row.id)) : null,
  };
}

/** The region must be listed in site/_data/regions.yml, which the build publishes as /regions.json. */
async function requireRegion(req: Request, env: Env, id: unknown): Promise<string> {
  if (typeof id === 'string' && REGION_ID.test(id)) {
    const res = await env.ASSETS.fetch(new URL('/regions.json', req.url));
    if (!res.ok) throw new Error('regions.json is missing from the site build');
    const regions = await res.json() as { id: string }[];
    if (regions.some((r) => r.id === id)) return id;
  }
  throw new HttpError(400, 'Unknown region.');
}
