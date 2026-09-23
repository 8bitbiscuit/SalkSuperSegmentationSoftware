import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Backend, Env, Instance } from '../src/env.ts';
import { liveSession, reap, refresh, type Row } from '../src/lifecycle.ts';
import { fakeD1 } from './d1.ts';

const MIN = 60_000;

function setup(instances: Instance[] = [], { healthy = false } = {}) {
  const env = { DB: fakeD1() } as Env;
  const calls = { terminated: [] as string[], removed: [] as string[] };
  const b: Backend = {
    cloud: {
      launch: async () => 'i-new',
      instances: async (session) => instances.filter((i) => !session || i.session === session),
      requestStop: async () => {},
      terminate: async (ids) => { calls.terminated.push(...ids); },
      listMasks: async () => [],
    },
    tunnels: {
      create: async () => ({ id: 'tun', token: 'tok' }),
      healthy: async () => healthy,
      remove: async (name) => { calls.removed.push(name); },
    },
    desktopUrl: () => 'https://desktop',
  };
  return { env, b, calls };
}

async function insert(env: Env, fields: Partial<Row>): Promise<Row> {
  const row: Row = {
    id: 'aaaaaaaaaa', email: 'jdoe@example.org', username: 'jdoe', region: 'r1', resume_key: null,
    hostname: 's-aaaaaaaaaa.example.org', state: 'starting', tunnel_id: 'tun', instance_id: 'i-1',
    error: null, created_at: Date.now(), ready_at: null, stop_requested_at: null, ended_at: null,
    ...fields,
  };
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...cols.map((c) => row[c as keyof Row])).run();
  return row;
}

const running = (session = 'aaaaaaaaaa', id = 'i-1'): Instance => ({ id, session, state: 'running' });

test('a starting session becomes ready once its tunnel is healthy', async () => {
  const { env, b } = setup([running()], { healthy: true });
  const row = await refresh(env, b, await insert(env, {}), running());
  assert.equal(row.state, 'ready');
  assert.equal((await liveSession(env.DB, 'jdoe@example.org'))?.state, 'ready');
});

test('a starting session stays starting while the tunnel is down', async () => {
  const { env, b } = setup([running()]);
  const row = await refresh(env, b, await insert(env, {}), running());
  assert.equal(row.state, 'starting');
});

test('an instance that is not visible yet is given time to appear', async () => {
  const { env, b, calls } = setup();
  const row = await refresh(env, b, await insert(env, { created_at: Date.now() - MIN }), undefined);
  assert.equal(row.state, 'starting');
  assert.deepEqual(calls.removed, []);
});

test('a ready session whose instance is gone ends and loses its tunnel', async () => {
  const { env, b, calls } = setup();
  const row = await refresh(env, b, await insert(env, { state: 'ready' }), undefined);
  assert.equal(row.state, 'ended');
  assert.ok(row.ended_at);
  assert.deepEqual(calls.removed, ['annotate-aaaaaaaaaa']);
  assert.equal(await liveSession(env.DB, 'jdoe@example.org'), null);
});

test('a starting session whose instance never showed up fails', async () => {
  const { env, b } = setup();
  const row = await refresh(env, b, await insert(env, { created_at: Date.now() - 10 * MIN }), undefined);
  assert.equal(row.state, 'failed');
  assert.match(row.error ?? '', /before it was ready/);
});

test('one live session per user; a new one is allowed once the old one ends', async () => {
  const { env } = setup();
  await insert(env, {});
  await assert.rejects(insert(env, { id: 'bbbbbbbbbb' }), /UNIQUE/);
  await env.DB.prepare('UPDATE sessions SET ended_at = 1 WHERE id = ?').bind('aaaaaaaaaa').run();
  await insert(env, { id: 'bbbbbbbbbb' });
});

test('the reaper terminates instances no live session owns', async () => {
  const { env, b, calls } = setup([running(), running('zzzzzzzzzz', 'i-orphan')]);
  await insert(env, {});
  await reap(env, b);
  assert.deepEqual(calls.terminated, ['i-orphan']);
});

test('the reaper fails a boot that never finished', async () => {
  const { env, b, calls } = setup([running()]);
  await insert(env, { created_at: Date.now() - 25 * MIN });
  await reap(env, b);
  assert.deepEqual(calls.terminated, ['i-1']);
  assert.equal(await liveSession(env.DB, 'jdoe@example.org'), null);
});

test('the reaper terminates a session that was asked to stop and did not', async () => {
  const { env, b, calls } = setup([running()]);
  await insert(env, { state: 'stopping', stop_requested_at: Date.now() - 40 * MIN });
  await reap(env, b);
  assert.deepEqual(calls.terminated, ['i-1']);
});

test('the reaper leaves a healthy session alone', async () => {
  const { env, b, calls } = setup([running()]);
  await insert(env, { state: 'ready', created_at: Date.now() - 6 * 60 * MIN });
  await reap(env, b);
  assert.deepEqual(calls.terminated, []);
  assert.equal((await liveSession(env.DB, 'jdoe@example.org'))?.state, 'ready');
});
