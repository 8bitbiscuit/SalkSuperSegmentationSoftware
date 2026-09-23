// Sign-in through a fake Cognito: a real RSA key signs the ID tokens, and
// fetch answers for Cognito's key set and token endpoint.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { currentLogin, handleAuth } from '../src/auth.ts';
import type { Env } from '../src/env.ts';
import { fakeD1 } from './d1.ts';

const COGNITO = 'https://salk-annotate.auth.us-west-2.amazoncognito.com';
const ISSUER = 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_Pool';
const SITE = 'https://annotate.example.org';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

const idToken = (claims: Record<string, unknown> = {}, audience = 'client-id') =>
  new SignJWT({ token_use: 'id', email: 'KPotts@Salk.edu', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER).setAudience(audience).setIssuedAt().setExpirationTime('1h')
    .sign(privateKey);

function newEnv(): Env {
  return {
    DB: fakeD1(), AWS_REGION: 'us-west-2', COGNITO_USER_POOL_ID: 'us-west-2_Pool',
    COGNITO_CLIENT_ID: 'client-id', COGNITO_CLIENT_SECRET: 'client-secret',
  } as Env;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Cognito's discovery document, key set, and a token endpoint that hands out `token`. Returns the token requests. */
function fakeCognito(token: string) {
  const requests: { auth: string | null; body: URLSearchParams }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        authorization_endpoint: `${COGNITO}/oauth2/authorize`, token_endpoint: `${COGNITO}/oauth2/token`,
        end_session_endpoint: `${COGNITO}/logout`,
      });
    }
    if (req.url === `${ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    if (req.url === `${COGNITO}/oauth2/token`) {
      requests.push({ auth: req.headers.get('authorization'), body: new URLSearchParams(await req.text()) });
      return Response.json({ id_token: token, refresh_token: 'refresh-1', token_type: 'Bearer' });
    }
    throw new Error(`unexpected fetch ${req.url}`);
  }) as typeof fetch;
  return requests;
}

const get = (path: string, cookie = '') => new Request(`${SITE}${path}`, { headers: cookie ? { cookie } : {} });
const auth = (env: Env, req: Request) => handleAuth(req, env, new URL(req.url));
const cookieFrom = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))!.split(';')[0];

async function signIn(env: Env) {
  const login = await auth(env, get('/auth/login'));
  const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
  const res = await auth(env, get(`/auth/callback?code=the-code&state=${state}`, cookieFrom(login, '__Host-annotate_state')));
  return { login, res };
}

test('signing in sends people to Cognito, then keeps who they are', async () => {
  const env = newEnv();
  const requests = fakeCognito(await idToken());
  const { login, res } = await signIn(env);

  const to = new URL(login.headers.get('location')!);
  assert.equal(`${to.origin}${to.pathname}`, `${COGNITO}/oauth2/authorize`);
  assert.equal(to.searchParams.get('client_id'), 'client-id');
  assert.equal(to.searchParams.get('redirect_uri'), `${SITE}/auth/callback`);
  assert.equal(to.searchParams.get('scope'), 'openid email profile');

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  assert.equal(requests[0].auth, `Basic ${btoa('client-id:client-secret')}`);
  assert.equal(requests[0].body.get('grant_type'), 'authorization_code');
  assert.equal(requests[0].body.get('code'), 'the-code');

  const cookie = cookieFrom(res, '__Host-annotate_login');
  assert.match(res.headers.getSetCookie().join('\n'), /__Host-annotate_login=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  const who = await currentLogin(get('/', cookie), env);
  assert.equal(who?.email, 'kpotts@salk.edu');
  assert.equal(who?.refresh_token, 'refresh-1');
});

test('a callback whose state does not match the browser\'s is refused', async () => {
  const env = newEnv();
  const requests = fakeCognito(await idToken());
  const res = await auth(env, get('/auth/callback?code=c&state=forged', '__Host-annotate_state=real'));
  assert.equal(res.status, 400);
  assert.equal(requests.length, 0);
});

test('an ID token meant for another app is refused', async () => {
  const env = newEnv();
  fakeCognito(await idToken({}, 'some-other-client'));
  const { res } = await signIn(env);
  assert.equal(res.status, 502);
  assert.equal(res.headers.getSetCookie().some((c) => c.startsWith('__Host-annotate_login=')), false);
});

test('an access token is not accepted as an ID token', async () => {
  const env = newEnv();
  fakeCognito(await idToken({ token_use: 'access' }));
  assert.equal((await signIn(env)).res.status, 502);
});

test('a user pool without a sign-in domain gets a page saying what to add', async () => {
  const env = { ...newEnv(), COGNITO_USER_POOL_ID: 'us-west-2_NoDomain' };
  globalThis.fetch = (async () => Response.json({ issuer: 'x', jwks_uri: 'y' })) as typeof fetch;
  const res = await auth(env, get('/auth/login'));
  assert.equal(res.status, 503);
  assert.match(await res.text(), /Branding → Domain/);
});

test('signing out ends the login here and at Cognito', async () => {
  const env = newEnv();
  fakeCognito(await idToken());
  const cookie = cookieFrom((await signIn(env)).res, '__Host-annotate_login');

  const res = await auth(env, get('/auth/logout', cookie));
  const to = new URL(res.headers.get('location')!);
  assert.equal(`${to.origin}${to.pathname}`, `${COGNITO}/logout`);
  assert.equal(to.searchParams.get('logout_uri'), `${SITE}/`);
  assert.equal(await currentLogin(get('/', cookie), env), null);
});
