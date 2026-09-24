import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Env } from '../src/env.ts';
import worker from '../src/index.ts';
import { missingSettings, parseDataUrl, withSettings } from '../src/settings.ts';
import { fakeD1 } from './d1.ts';

const ready = {
  DATA_URL: 's3://salk-workstation-data-dev-020125249408/spida_dev/cellpose_3d_test/patches',
  COGNITO_USER_POOL_ID: 'us-west-2_AbC123xyz', COGNITO_CLIENT_ID: 'client', COGNITO_CLIENT_SECRET: 'secret',
  AWS_ROLE_ARN: 'arn:aws:iam::020125249408:role/annotate-user',
} as Env;

test('an S3 URL gives the bucket and a folder prefix ending in /', () => {
  assert.deepEqual(parseDataUrl('s3://my-bucket/a/b'), { bucket: 'my-bucket', prefix: 'a/b/' });
  assert.deepEqual(parseDataUrl(' s3://my-bucket/a/b/ '), { bucket: 'my-bucket', prefix: 'a/b/' });
  assert.deepEqual(parseDataUrl('s3://my-bucket'), { bucket: 'my-bucket', prefix: '' });
  assert.equal(parseDataUrl('https://my-bucket.s3.amazonaws.com/a'), null);
  assert.equal(parseDataUrl('my-bucket/a'), null);
});

test('missing and malformed settings are named; a filled-in site has none', () => {
  assert.deepEqual(missingSettings({} as Env), [
    'DATA_URL', 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_CLIENT_SECRET', 'AWS_ROLE_ARN',
  ]);
  assert.deepEqual(missingSettings({ ...ready, DATA_URL: 'bucket/folder', COGNITO_USER_POOL_ID: 'Pool' }), [
    'DATA_URL (must look like s3://bucket/folder/)', 'COGNITO_USER_POOL_ID (must look like us-west-2_AbC123xyz)',
  ]);
  assert.deepEqual(missingSettings(ready), []);
  assert.deepEqual(missingSettings({ BACKEND: 'mock' } as Env), []);
});

test('the rest is worked out: bucket, prefix, region from the pool, channel and idle time', () => {
  const env = withSettings(ready);
  assert.equal(env.BUCKET, 'salk-workstation-data-dev-020125249408');
  assert.equal(env.DATA_PREFIX, 'spida_dev/cellpose_3d_test/patches/');
  assert.equal(env.AWS_REGION, 'us-west-2');
  assert.equal(env.CHANNEL, 'DAPI_decon');
  assert.equal(env.IDLE_MINUTES, '30');
  assert.equal(env.DESKTOP_HOSTNAME, undefined);
  assert.equal(withSettings({ ...ready, COGNITO_USER_POOL_ID: 'eu-central-1_X', CHANNEL: 'PVALB_decon' }).AWS_REGION, 'eu-central-1');
  assert.equal(withSettings({ ...ready, CHANNEL: 'PVALB_decon' }).CHANNEL, 'PVALB_decon');
});

test('pasted values lose surrounding spaces, line breaks and quote marks', () => {
  const env = withSettings({ ...ready, COGNITO_CLIENT_SECRET: ' "s3cret"\n', COGNITO_CLIENT_ID: 'client ', DATA_URL: '"s3://b-1/x"' });
  assert.equal(env.COGNITO_CLIENT_SECRET, 's3cret');
  assert.equal(env.COGNITO_CLIENT_ID, 'client');
  assert.equal(env.BUCKET, 'b-1');
  assert.deepEqual(missingSettings(env), []);
});

test('a fresh deploy with no settings serves a page listing what to add', async () => {
  const env = { DB: fakeD1() } as Env;
  const ctx = {} as ExecutionContext;
  const page = await worker.fetch!(new Request('https://annotate.example.workers.dev/') as never, env, ctx);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /Variables and Secrets[\s\S]*COGNITO_CLIENT_SECRET/);

  const api = await worker.fetch!(new Request('https://annotate.example.workers.dev/api/state') as never, env, ctx);
  assert.equal(api.status, 503);
  assert.match((await api.json() as { error: string }).error, /Missing: DATA_URL/);
});
