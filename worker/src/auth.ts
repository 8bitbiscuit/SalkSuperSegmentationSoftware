// Sign-in through the Cognito user pool (its hosted sign-in page, OAuth
// authorization-code flow). A login keeps the user's Cognito tokens, so the
// Worker, and later their desktop, can act on AWS as that user.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError, need, type Env } from './env.ts';

export interface Login {
  id: string;                  // random; the cookie's value
  email: string;
  refresh_token: string;
  id_token: string;
  id_token_expires_at: number;
  created_at: number;
  signed_out_at: number | null;
}

export const LOGIN_HOURS = 12;
const LOGIN_COOKIE = '__Host-annotate_login';
const STATE_COOKIE = '__Host-annotate_state';

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomId = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

const cookie = (req: Request, name: string) =>
  req.headers.get('cookie')?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

function redirect(location: string, ...cookies: string[]): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

const page = (status: number, message: string) => new Response(
  `<!doctype html><meta charset="utf-8"><title>Sign-in</title><p>${message} <a href="/auth/login">Sign in again</a>.</p>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const issuerOf = (env: Env) => `https://cognito-idp.${env.AWS_REGION}.amazonaws.com/${env.COGNITO_USER_POOL_ID}`;

interface Endpoints { authorize: string; token: string; logout: string }
const discovered = new Map<string, Promise<Endpoints>>();

/**
 * The pool's sign-in, token and sign-out addresses, from its OpenID
 * configuration, so the pool ID is all the site needs to be told.
 */
function endpoints(env: Env): Promise<Endpoints> {
  const issuer = issuerOf(env);
  let p = discovered.get(issuer);
  if (!p) {
    p = fetch(`${issuer}/.well-known/openid-configuration`)
      .then((res) => {
        if (!res.ok) throw new Error(`Cognito has no user pool ${env.COGNITO_USER_POOL_ID} (HTTP ${res.status})`);
        return res.json() as Promise<{ authorization_endpoint?: string; token_endpoint?: string; end_session_endpoint?: string }>;
      })
      .then((c) => {
        if (!c.authorization_endpoint || !c.token_endpoint) {
          throw new Error('The user pool has no domain yet. Add one in Cognito under Branding → Domain');
        }
        return {
          authorize: c.authorization_endpoint,
          token: c.token_endpoint,
          logout: c.end_session_endpoint ?? new URL('/logout', c.authorization_endpoint).toString(),
        };
      });
    p.catch(() => discovered.delete(issuer));   // look again next time
    discovered.set(issuer, p);
  }
  return p;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Check a Cognito ID token's signature, issuer, audience and type; return its email and expiry. */
async function verifyIdToken(env: Env, token: string): Promise<{ email: string; expiresAt: number }> {
  const issuer = issuerOf(env);
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.COGNITO_CLIENT_ID });
  if (payload.token_use !== 'id' || typeof payload.email !== 'string' || !payload.exp) {
    throw new Error('Cognito sent an ID token without an email');
  }
  return { email: payload.email.toLowerCase(), expiresAt: payload.exp * 1000 };
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<{ id_token: string; refresh_token?: string }> {
  const res = await fetch((await endpoints(env)).token, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${env.COGNITO_CLIENT_ID}:${env.COGNITO_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({ client_id: env.COGNITO_CLIENT_ID!, ...params }).toString(),
  });
  const data = await res.json().catch(() => ({})) as { id_token?: string; refresh_token?: string; error?: string };
  if (data.error === 'invalid_client') {
    throw new Error('Cognito did not accept the app\'s credentials (invalid_client). Paste COGNITO_CLIENT_SECRET into the '
      + 'Cloudflare settings again, copied with: terraform output -raw cognito_client_secret | pbcopy');
  }
  if (!res.ok || !data.id_token) throw new Error(`Cognito refused the sign-in (${data.error ?? res.status})`);
  return data as { id_token: string; refresh_token?: string };
}

/** /auth/login, /auth/callback and /auth/logout. */
export async function handleAuth(req: Request, env: Env, url: URL): Promise<Response> {
  need(env, 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_CLIENT_SECRET', 'AWS_REGION');
  const callback = new URL('/auth/callback', url).toString();
  let cognito: Endpoints;
  try {
    cognito = await endpoints(env);
  } catch (err) {
    return page(503, `Can't reach Cognito: ${err instanceof Error ? err.message : err}.`);
  }

  if (url.pathname === '/auth/login') {
    const state = randomId();
    const to = new URL(cognito.authorize);
    to.search = new URLSearchParams({
      response_type: 'code', client_id: env.COGNITO_CLIENT_ID!, redirect_uri: callback,
      scope: 'openid email profile', state,
    }).toString();
    return redirect(to.toString(), setCookie(STATE_COOKIE, state, 600));
  }

  if (url.pathname === '/auth/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || state !== cookie(req, STATE_COOKIE)) return page(400, 'That sign-in link has expired.');
    try {
      const tokens = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: callback });
      const { email, expiresAt } = await verifyIdToken(env, tokens.id_token);
      const id = randomId();
      await env.DB.prepare(`INSERT INTO logins (id, email, refresh_token, id_token, id_token_expires_at, created_at)
                            VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id, email, tokens.refresh_token ?? '', tokens.id_token, expiresAt, Date.now()).run();
      return redirect('/', setCookie(LOGIN_COOKIE, id, LOGIN_HOURS * 3600), setCookie(STATE_COOKIE, '', 0));
    } catch (err) {
      console.error(err);
      return page(502, `Sign-in failed: ${err instanceof Error ? err.message : err}.`);
    }
  }

  if (url.pathname === '/auth/logout') {
    const id = cookie(req, LOGIN_COOKIE);
    // Only marked: a desktop still running for this login keeps saving as the user.
    if (id) await env.DB.prepare('UPDATE logins SET signed_out_at = ? WHERE id = ?').bind(Date.now(), id).run();
    const to = new URL(cognito.logout);
    to.search = new URLSearchParams({ client_id: env.COGNITO_CLIENT_ID!, logout_uri: new URL('/', url).toString() }).toString();
    return redirect(to.toString(), setCookie(LOGIN_COOKIE, '', 0));
  }

  return new Response('Not found', { status: 404 });
}

/** The signed-in login behind this request, or null. */
export async function currentLogin(req: Request, env: Env): Promise<Login | null> {
  const id = cookie(req, LOGIN_COOKIE);
  if (!id) return null;
  return env.DB.prepare('SELECT * FROM logins WHERE id = ? AND signed_out_at IS NULL AND created_at > ?')
    .bind(id, Date.now() - LOGIN_HOURS * 3_600_000).first<Login>();
}

/** A current Cognito ID token for this login, refreshed when it is about to expire. */
export async function idToken(env: Env, login: Login): Promise<string> {
  if (login.id_token_expires_at - Date.now() > 5 * 60_000) return login.id_token;
  let fresh: { id_token: string };
  try {
    fresh = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: login.refresh_token });
  } catch {
    throw new HttpError(401, 'Your sign-in has expired. Please sign in again.');
  }
  const { expiresAt } = await verifyIdToken(env, fresh.id_token);
  await env.DB.prepare('UPDATE logins SET id_token = ?, id_token_expires_at = ? WHERE id = ?')
    .bind(fresh.id_token, expiresAt, login.id).run();
  login.id_token = fresh.id_token;
  login.id_token_expires_at = expiresAt;
  return fresh.id_token;
}
