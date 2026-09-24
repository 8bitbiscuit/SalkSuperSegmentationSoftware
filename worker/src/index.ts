import { currentLogin, handleAuth, idToken, type Login } from './auth.ts';
import { awsCloud, sessionName, userCredentials } from './aws.ts';
import { HttpError, json, type Backend, type Creds, type Env } from './env.ts';
import { finish, liveSession, reap, refresh, update, type Row } from './lifecycle.ts';
import { mockBackend, mockDesktopPage } from './mock.ts';
import { desktopSecret, ensureSchema } from './schema.ts';
import {
  hmacToken, hostnameFor, masksPrefix, newSessionId, parseMasksName, REGION_ID, tunnelName, userData, usernameOf,
} from './session.ts';
import { missingSettings, setupPage, withSettings } from './settings.ts';
import { cloudflareTunnels, quickTunnels } from './tunnel.ts';

// The DCV session every desktop runs; the web client's URL fragment names it.
const DCV_SESSION = 'annotate';
// Where the desktop keeps the signed-in user's current Cognito ID token.
const TOKEN_FILE = '/run/annotate-token/id-token';   // a root-only folder

/** Named tunnels on your domain once DESKTOP_HOSTNAME is set; quick tunnels until then. */
function tunnelsFor(env: Env) {
  if (env.BACKEND === 'mock') return mockBackend(env).tunnels;
  return env.DESKTOP_HOSTNAME ? cloudflareTunnels(env) : quickTunnels();
}

function backend(env: Env, creds: Creds | null): Backend {
  if (env.BACKEND === 'mock') return mockBackend(env);
  return {
    cloud: awsCloud(env, creds!),
    tunnels: tunnelsFor(env),
    desktopUrl: (hostname, _session, token) =>
      `https://${hostname}/?authToken=${encodeURIComponent(token)}#${DCV_SESSION}`,
  };
}

/** The session owner's AWS view, from their sign-in; null if that sign-in can't be used any more. */
async function asOwner(env: Env, row: Row): Promise<Backend | null> {
  if (env.BACKEND === 'mock') return mockBackend(env);
  const login = row.login_id
    ? await env.DB.prepare('SELECT * FROM logins WHERE id = ?').bind(row.login_id).first<Login>()
    : null;
  if (!login) return null;
  try {
    return backend(env, await userCredentials(env, login.email, await idToken(env, login)));
  } catch {
    return null;
  }
}

interface User {
  email: string;
  login: Login | null;   // null only for the pretend cloud
  creds: Creds | null;   // AWS credentials in the user's own name
}

/** Who is asking, with AWS credentials in their name. */
async function signedIn(req: Request, env: Env): Promise<User> {
  if (env.BACKEND === 'mock') {
    // The pretend cloud has no sign-in. Refuse to run it anywhere but localhost.
    const host = new URL(req.url).hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') throw new Error('BACKEND=mock is for local development only');
    return { email: env.DEV_EMAIL || 'dev.user@example.org', login: null, creds: null };
  }
  const login = await currentLogin(req, env);
  if (!login) throw new HttpError(401, 'Please sign in.');
  return { email: login.email, login, creds: await userCredentials(env, login.email, await idToken(env, login)) };
}

export default {
  async fetch(req, rawEnv): Promise<Response> {
    const url = new URL(req.url);
    const env = withSettings(rawEnv);

    // Until the dashboard has the required settings, every page says which are missing.
    const missing = missingSettings(env);
    if (missing.length) {
      return url.pathname.startsWith('/api/')
        ? json({ error: `The site isn't set up yet. Missing: ${missing.join(', ')}.` }, 503)
        : setupPage(missing);
    }
    await ensureSchema(env.DB);

    if (url.pathname.startsWith('/auth/')) {
      return env.BACKEND === 'mock' ? Response.redirect(new URL('/', url).toString(), 302) : handleAuth(req, env, url);
    }
    if (!url.pathname.startsWith('/api/')) {
      // Every page is for signed-in people only.
      if (env.BACKEND !== 'mock' && !(await currentLogin(req, env))) {
        return Response.redirect(new URL('/auth/login', url).toString(), 302);
      }
      return env.ASSETS.fetch(req);
    }

    try {
      // Browsers always send Origin on cross-site POST/DELETE; refuse those.
      const origin = req.headers.get('origin');
      if (req.method !== 'GET' && origin && origin !== url.origin) {
        throw new HttpError(403, 'Cross-site request refused.');
      }
      // The desktop asks with its own key, not a browser sign-in.
      if (req.method === 'GET' && url.pathname === '/api/desktop/token') return await desktopToken(req, env, url);
      if (req.method === 'POST' && url.pathname === '/api/desktop/address') return await desktopAddress(req, env, url);

      const user = await signedIn(req, env);
      const b = backend(env, user.creds);

      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/state': return json(await getState(env, b, user.email));
        case 'GET /api/folders': return json(await listFolders(env, b, url.searchParams.get('path') ?? ''));
        case 'GET /api/masks': return json(await listMasks(env, b, user.email, url.searchParams.get('region')));
        case 'POST /api/session': return json(await startSession(req, env, b, user), 202);
        case 'DELETE /api/session': return json(await endSession(env, b, user.email), 202);
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

  async scheduled(_controller, rawEnv, ctx) {
    const env = withSettings(rawEnv);
    if (missingSettings(env).length) return;
    ctx.waitUntil(ensureSchema(env.DB).then(() =>
      reap(env, (row) => asOwner(env, row), tunnelsFor(env))));
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
    signout: env.BACKEND === 'mock' ? null : '/auth/logout',
    session: live ? await view(env, b, live) : null,
    last: last && { region: last.region, state: last.state, error: last.error, ready_at: last.ready_at, ended_at: last.ended_at },
  };
}

async function listFolders(env: Env, b: Backend, path: string) {
  if (path && !REGION_ID.test(path)) throw new HttpError(400, 'Unknown folder.');
  return { channel: env.CHANNEL, ...(await b.cloud.listFolders(path)) };
}

async function listMasks(env: Env, b: Backend, email: string, region: unknown) {
  const id = await requireFolder(env, b, region);
  const prefix = masksPrefix(env.DATA_PREFIX, id);
  const masks = (await b.cloud.listMasks(id))
    .flatMap((f) => {
      const name = f.key.slice(prefix.length);
      const parsed = f.key.startsWith(prefix) && !name.includes('/') ? parseMasksName(name) : null;
      return parsed ? [{ key: f.key, name, user: parsed.user, saved_at: f.modified, size: f.size }] : [];
    })
    .sort((x, y) => y.saved_at.localeCompare(x.saved_at));
  return { username: usernameOf(email), masks };
}

async function startSession(req: Request, env: Env, b: Backend, user: User) {
  // Before any record exists: without the token a half-made session couldn't be cleaned up.
  if (env.BACKEND !== 'mock' && env.DESKTOP_HOSTNAME && !env.CF_API_TOKEN) {
    throw new HttpError(503, "Desktops can't start: DESKTOP_HOSTNAME is set, so the site also needs CF_API_TOKEN (README, desktops step).");
  }
  const body = await req.json().catch(() => null) as { region?: unknown; resume_key?: unknown } | null;
  const region = await requireFolder(env, b, body?.region);
  const email = user.email;

  let resume: string | null = null;
  if (body?.resume_key) {
    const key = body.resume_key;
    // Anyone may resume anyone's masks, but only a masks file of this folder.
    if (typeof key !== 'string' || !(await b.cloud.listMasks(region)).some((f) => f.key === key)) {
      throw new HttpError(400, 'That masks file is not in this folder any more. Reload the page.');
    }
    resume = key;
  }

  const secret = await desktopSecret(env.DB);
  const id = newSessionId();
  const row: Row = {
    id, email, username: usernameOf(email), region, resume_key: resume,
    hostname: env.DESKTOP_HOSTNAME ? hostnameFor(env.DESKTOP_HOSTNAME, id) : '',   // quick tunnel: reported later
    state: 'starting',
    tunnel_id: null, instance_id: null, error: null,
    created_at: Date.now(), ready_at: null, stop_requested_at: null, ended_at: null,
    login_id: user.login?.id ?? null,
  };

  try {
    await env.DB.prepare(`INSERT INTO sessions (id, email, username, region, resume_key, hostname, state, created_at, login_id)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.id, row.email, row.username, row.region, row.resume_key, row.hostname, row.state, row.created_at, row.login_id)
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
          DATA_PREFIX: env.DATA_PREFIX!,
          CHANNEL: env.CHANNEL!,
          SITE_URL: new URL(req.url).origin,
          AWS_REGION: env.AWS_REGION ?? '',
          // The desktop reaches the bucket as this user too (AssumeRoleWithWebIdentity).
          AWS_ROLE_ARN: env.AWS_ROLE_ARN ?? '',
          AWS_ROLE_SESSION_NAME: sessionName(email),
          AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE,
          IDLE_MINUTES: env.IDLE_MINUTES!,
        },
        {
          TUNNEL_TOKEN: tunnel.token,
          DCV_TOKEN: await hmacToken(secret, id),
          DESKTOP_KEY: await hmacToken(secret, `desktop:${id}`),
        },
      ),
    });
    await update(env.DB, id, { instance_id: row.instance_id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // If this cleanup fails too, the row stays live and the reaper retries it.
    await finish(env, b.tunnels, row, 'failed', message).catch((e) => console.error(`cleanup of ${id} failed:`, e));
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
    await finish(env, b.tunnels, row, 'ended', null);
    return { session: null };
  }

  // The instance saves and shuts itself down; the row closes once it's gone.
  await b.cloud.requestStop(instance.id);
  if (row.state !== 'stopping') {
    await update(env.DB, row.id, { state: 'stopping', stop_requested_at: Date.now() });
  }
  return { session: await view(env, b, { ...row, state: 'stopping' }) };
}

/**
 * A running desktop's current Cognito ID token for its user, so it can keep
 * reading images and saving masks as them. Asked for every 15 minutes with
 * the key the desktop was started with. It works after the user signs out
 * of the website, so a desktop mid-session can still save.
 */
/** The live session whose desktop sent this request, checked by the key only that desktop has. */
async function desktopSession(req: Request, env: Env, url: URL): Promise<Row> {
  const id = url.searchParams.get('session') ?? '';
  const given = new TextEncoder().encode((req.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND ended_at IS NULL').bind(id).first<Row>();
  const expected = new TextEncoder().encode(await hmacToken(await desktopSecret(env.DB), `desktop:${id}`));
  if (!row || given.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(given, expected)) {
    throw new HttpError(403, 'Not a running desktop.');
  }
  return row;
}

/** POST /api/desktop/address: a desktop without a domain reports its quick tunnel's address (again after a restart). */
async function desktopAddress(req: Request, env: Env, url: URL): Promise<Response> {
  const row = await desktopSession(req, env, url);
  const host = /^https:\/\/([a-z0-9-]+\.trycloudflare\.com)\/?$/.exec((await req.text()).trim())?.[1];
  if (env.DESKTOP_HOSTNAME || !host) throw new HttpError(400, 'Not a quick tunnel address.');
  await update(env.DB, row.id, { hostname: host, tunnel_id: host });
  return new Response(null, { status: 204 });
}

async function desktopToken(req: Request, env: Env, url: URL): Promise<Response> {
  const row = await desktopSession(req, env, url);
  if (!row.login_id) throw new HttpError(403, 'Not a running desktop.');
  const login = await env.DB.prepare('SELECT * FROM logins WHERE id = ?').bind(row.login_id).first<Login>();
  if (!login) throw new HttpError(403, 'The sign-in behind this desktop is gone.');
  return new Response(await idToken(env, login), { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
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
    url: row.state === 'ready' ? b.desktopUrl(row.hostname, row.id, await hmacToken(await desktopSecret(env.DB), row.id)) : null,
  };
}

/** A folder under DATA_PREFIX that holds the channel's z-slices, checked in the bucket as the user. */
async function requireFolder(env: Env, b: Backend, id: unknown): Promise<string> {
  if (typeof id !== 'string' || !REGION_ID.test(id)) throw new HttpError(400, 'Unknown folder.');
  if (!(await b.cloud.listFolders(id)).images) {
    throw new HttpError(400, `There are no ${env.CHANNEL}_z*.tif images in ${id}.`);
  }
  return id;
}
