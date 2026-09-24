// Desktops without a domain: quick tunnels, and the address a desktop reports.
import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { afterEach, test } from 'node:test';
import type { Env } from '../src/env.ts';
import worker from '../src/index.ts';
import { desktopSecret } from '../src/schema.ts';
import { hmacToken } from '../src/session.ts';
import { quickTunnels } from '../src/tunnel.ts';
import { fakeD1 } from './d1.ts';

// Workers adds timingSafeEqual to crypto.subtle; Node keeps it in node:crypto.
(crypto.subtle as unknown as Record<string, unknown>).timingSafeEqual ??= timingSafeEqual;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settings = {
  DATA_URL: 's3://b-1/data/', COGNITO_USER_POOL_ID: 'us-west-2_Pool', COGNITO_CLIENT_ID: 'c',
  COGNITO_CLIENT_SECRET: 's', AWS_ROLE_ARN: 'arn:aws:iam::1:role/annotate-user',
};

async function withSession(extra: Partial<Env> = {}) {
  const env = { DB: fakeD1(), ...settings, ...extra } as Env;
  await env.DB.prepare(`INSERT INTO sessions (id, email, username, region, hostname, state, tunnel_id, created_at)
                        VALUES ('aaaaaaaaaa', 'jdoe@example.org', 'jdoe', 'r1', '', 'starting', '', 1)`).run();
  const key = await hmacToken(await desktopSecret(env.DB), 'desktop:aaaaaaaaaa');
  const report = (address: string, auth = key) => worker.fetch!(new Request(
    'https://site.example/api/desktop/address?session=aaaaaaaaaa',
    { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: address }) as never, env, {} as ExecutionContext);
  const row = async () => ({ ...await env.DB.prepare("SELECT hostname, tunnel_id FROM sessions WHERE id = 'aaaaaaaaaa'").first() });
  return { report, row };
}

test('a desktop reports its quick tunnel address, which becomes the session\'s', async () => {
  const { report, row } = await withSession();
  assert.equal((await report('https://calm-river-4f2a.trycloudflare.com\n')).status, 204);
  assert.deepEqual(await row(), { hostname: 'calm-river-4f2a.trycloudflare.com', tunnel_id: 'calm-river-4f2a.trycloudflare.com' });
});

test('only the desktop\'s own key, and only a trycloudflare.com address, are accepted', async () => {
  const { report, row } = await withSession();
  assert.equal((await report('https://calm-river-4f2a.trycloudflare.com', 'wrong')).status, 403);
  assert.equal((await report('https://evil.example')).status, 400);
  assert.equal((await report('https://x.trycloudflare.com.evil.example')).status, 400);
  assert.deepEqual(await row(), { hostname: '', tunnel_id: '' });
});

test('with a domain set, desktops use named tunnels and reported addresses are refused', async () => {
  const { report } = await withSession({ DESKTOP_HOSTNAME: 'annotate-{id}.example.org', CF_API_TOKEN: 't' });
  assert.equal((await report('https://calm-river-4f2a.trycloudflare.com')).status, 400);
});

test('a quick tunnel is healthy once something answers behind it', async () => {
  const answers = [530, 502, 200, 302];
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response('x', { status: answers.shift() });
  }) as typeof fetch;
  const t = quickTunnels();
  assert.deepEqual([await t.healthy('a.trycloudflare.com'), await t.healthy('a.trycloudflare.com'),
    await t.healthy('a.trycloudflare.com'), await t.healthy('a.trycloudflare.com')], [false, false, true, true]);
  assert.equal(asked[0], 'https://a.trycloudflare.com/');
  globalThis.fetch = (async () => { throw new Error('no such host'); }) as typeof fetch;
  assert.equal(await t.healthy('gone.trycloudflare.com'), false);
});
