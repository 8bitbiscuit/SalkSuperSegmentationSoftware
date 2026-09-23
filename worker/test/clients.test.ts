// The AWS and Cloudflare clients against canned responses: what they send,
// and how they read what comes back.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { awsCloud } from '../src/aws.ts';
import type { Env } from '../src/env.ts';
import { cloudflareTunnels } from '../src/tunnel.ts';
import { parseXml, text } from '../src/xml.ts';

const env = {
  AWS_REGION: 'us-west-2', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret',
  LAUNCH_TEMPLATE_ID: 'lt-0123', BUCKET: 'annotate-data',
  CF_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: 'acct', CF_ZONE_ID: 'zone',
} as Env;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Replace fetch with canned responses, in order; returns the requests made. */
function stubFetch(...responses: Response[]) {
  const seen: { method: string; url: string; body: string; auth: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ method: req.method, url: req.url, body: await req.text(), auth: req.headers.get('authorization') });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${req.method} ${req.url}`);
    return next;
  }) as typeof fetch;
  return seen;
}

const xml = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/xml' } });

test('the XML reader handles entities and self-closing tags', () => {
  const doc = parseXml('<?xml version="1.0"?><a xmlns="urn:x"><b>R&amp;D &lt;1&gt; &#65;&#x42;</b><c/><d>x</d></a>');
  assert.equal(text(doc, 'a', 'b'), 'R&D <1> AB');
  assert.equal(text(doc, 'a', 'd'), 'x');
});

test('instances() filters to live annotate instances and reads tags across pages', async () => {
  const page = (items: string, next = '') => xml(`<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <reservationSet><item><instancesSet>${items}</instancesSet></item></reservationSet>
  ${next ? `<nextToken>${next}</nextToken>` : ''}
</DescribeInstancesResponse>`);
  const instance = (id: string, state: string, session: string) => `<item>
    <instanceId>${id}</instanceId>
    <instanceState><code>16</code><name>${state}</name></instanceState>
    <networkInterfaceSet><item><attachment><status>attached</status></attachment></item></networkInterfaceSet>
    <tagSet><item><key>App</key><value>annotate</value></item><item><key>Session</key><value>${session}</value></item></tagSet>
  </item>`;

  const seen = stubFetch(
    page(instance('i-1', 'running', 'aaaaaaaaaa'), 'page2'),
    page(instance('i-2', 'pending', 'bbbbbbbbbb')),
  );
  const found = await awsCloud(env).instances('aaaaaaaaaa');

  assert.deepEqual(found, [
    { id: 'i-1', session: 'aaaaaaaaaa', state: 'running' },
    { id: 'i-2', session: 'bbbbbbbbbb', state: 'pending' },
  ]);
  const params = new URLSearchParams(seen[0].body);
  assert.equal(seen[0].url, 'https://ec2.us-west-2.amazonaws.com/');
  assert.match(seen[0].auth ?? '', /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/ec2\/aws4_request/);
  assert.equal(params.get('Action'), 'DescribeInstances');
  assert.equal(params.get('Filter.1.Name'), 'tag:App');
  assert.equal(params.get('Filter.1.Value.1'), 'annotate');
  assert.equal(params.get('Filter.2.Name'), 'instance-state-name');
  assert.equal(params.get('Filter.3.Name'), 'tag:Session');
  assert.equal(params.get('Filter.3.Value.1'), 'aaaaaaaaaa');
  assert.equal(new URLSearchParams(seen[1].body).get('NextToken'), 'page2');
});

test('launch() uses the launch template, an idempotency token, tags and user data', async () => {
  const seen = stubFetch(xml(`<RunInstancesResponse><instancesSet><item><instanceId>i-9</instanceId></item></instancesSet></RunInstancesResponse>`));
  const id = await awsCloud(env).launch({
    session: 'aaaaaaaaaa', email: 'jdoe@example.org', username: 'jdoe', region: 'r1', userData: '#cloud-config\n',
  });
  assert.equal(id, 'i-9');
  const p = new URLSearchParams(seen[0].body);
  assert.equal(p.get('Action'), 'RunInstances');
  assert.equal(p.get('LaunchTemplate.LaunchTemplateId'), 'lt-0123');
  assert.equal(p.get('ClientToken'), 'aaaaaaaaaa');
  assert.equal(atob(p.get('UserData')!), '#cloud-config\n');
  assert.equal(p.get('TagSpecification.1.ResourceType'), 'instance');
  assert.equal(p.get('TagSpecification.1.Tag.1.Key'), 'App');
  assert.equal(p.get('TagSpecification.1.Tag.1.Value'), 'annotate');
  assert.equal(p.get('TagSpecification.1.Tag.2.Value'), 'aaaaaaaaaa');
});

test('EC2 errors surface their code and message', async () => {
  stubFetch(xml(`<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>You are not authorized</Message></Error></Errors></Response>`, 403));
  await assert.rejects(awsCloud(env).terminate(['i-1']), /TerminateInstances failed: UnauthorizedOperation You are not authorized/);
});

test('listMasks() pages through the region\'s masks prefix', async () => {
  const seen = stubFetch(
    xml(`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken>
      <Contents><Key>regions/r1/masks/jdoe_20260915T101500_masks.tif.gz</Key><LastModified>2026-09-15T10:20:00.000Z</LastModified><Size>1234</Size></Contents>
    </ListBucketResult>`),
    xml(`<ListBucketResult><IsTruncated>false</IsTruncated>
      <Contents><Key>regions/r1/masks/a&amp;b_20260916T101500_masks.tif.gz</Key><LastModified>2026-09-16T10:20:00.000Z</LastModified><Size>5</Size></Contents>
    </ListBucketResult>`),
  );
  const files = await awsCloud(env).listMasks('r1');
  assert.deepEqual(files.map((f) => f.key), [
    'regions/r1/masks/jdoe_20260915T101500_masks.tif.gz',
    'regions/r1/masks/a&b_20260916T101500_masks.tif.gz',
  ]);
  assert.equal(files[0].size, 1234);
  const first = new URL(seen[0].url);
  assert.equal(first.host, 'annotate-data.s3.us-west-2.amazonaws.com');
  assert.equal(first.searchParams.get('prefix'), 'regions/r1/masks/');
  assert.equal(new URL(seen[1].url).searchParams.get('continuation-token'), 't2');
});

const cf = (result: unknown, status = 200) =>
  Response.json({ success: status < 400, errors: status < 400 ? [] : [{ code: 1000, message: 'nope' }], result }, { status });

test('create() makes the tunnel, routes it to DCV, adds DNS and returns the token', async () => {
  const seen = stubFetch(cf({ id: 'tid' }), cf({}), cf({ id: 'rec' }), cf('the-token'));
  const t = await cloudflareTunnels(env).create('annotate-aaaaaaaaaa', 's-aaaaaaaaaa.example.org');
  assert.deepEqual(t, { id: 'tid', token: 'the-token' });

  assert.deepEqual(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`), [
    'POST /client/v4/accounts/acct/cfd_tunnel',
    'PUT /client/v4/accounts/acct/cfd_tunnel/tid/configurations',
    'POST /client/v4/zones/zone/dns_records',
    'GET /client/v4/accounts/acct/cfd_tunnel/tid/token',
  ]);
  assert.equal(seen[0].auth, 'Bearer cf-token');
  const ingress = JSON.parse(seen[1].body).config.ingress;
  assert.equal(ingress[0].hostname, 's-aaaaaaaaaa.example.org');
  assert.equal(ingress[0].service, 'https://localhost:8443');
  assert.equal(ingress.at(-1).service, 'http_status:404');
  assert.deepEqual(JSON.parse(seen[2].body), {
    type: 'CNAME', name: 's-aaaaaaaaaa.example.org', content: 'tid.cfargotunnel.com', proxied: true, comment: 'annotate-aaaaaaaaaa',
  });
});

test('remove() deletes only records and tunnels with exactly the session\'s names', async () => {
  const seen = stubFetch(
    // As if the API ignored the name filter and returned everything:
    cf([{ id: 'r-mine', name: 's-aaaaaaaaaa.example.org' }, { id: 'r-www', name: 'www.example.org' }]),
    cf({}),
    cf([{ id: 't-mine', name: 'annotate-aaaaaaaaaa' }, { id: 't-other', name: 'office' }]),
    cf({}),
    cf({}),
  );
  await cloudflareTunnels(env).remove('annotate-aaaaaaaaaa', 's-aaaaaaaaaa.example.org');
  const deletes = seen.filter((r) => r.method === 'DELETE').map((r) => new URL(r.url).pathname);
  assert.deepEqual(deletes, [
    '/client/v4/zones/zone/dns_records/r-mine',
    '/client/v4/accounts/acct/cfd_tunnel/t-mine/connections',
    '/client/v4/accounts/acct/cfd_tunnel/t-mine',
  ]);
});

test('Cloudflare errors surface their code and message', async () => {
  stubFetch(cf(null, 403));
  await assert.rejects(cloudflareTunnels(env).healthy('tid'), /1000 nope/);
});
