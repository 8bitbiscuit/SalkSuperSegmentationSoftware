// The AWS and Cloudflare clients against canned responses: what they send,
// and how they read what comes back.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { awsCloud, sessionName, userCredentials } from '../src/aws.ts';
import type { Env } from '../src/env.ts';
import { cloudflareTunnels } from '../src/tunnel.ts';
import { parseXml, text } from '../src/xml.ts';

const env = {
  AWS_REGION: 'us-west-2', BUCKET: 'annotate-data',
  DATA_PREFIX: 'spida_dev/patches/', CHANNEL: 'DAPI_decon',
  AWS_ROLE_ARN: 'arn:aws:iam::020125249408:role/annotate-user',
  CF_API_TOKEN: 'cf-token', DESKTOP_HOSTNAME: 's-{id}.example.org',
} as Env;

const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session' };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Replace fetch with canned responses, in order; returns the requests made. */
function stubFetch(...responses: Response[]) {
  const seen: { method: string; url: string; body: string; auth: string | null; token: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({
      method: req.method, url: req.url, body: await req.text(),
      auth: req.headers.get('authorization'), token: req.headers.get('x-amz-security-token'),
    });
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
  const found = await awsCloud(env, creds).instances('aaaaaaaaaa');

  assert.deepEqual(found, [
    { id: 'i-1', session: 'aaaaaaaaaa', state: 'running' },
    { id: 'i-2', session: 'bbbbbbbbbb', state: 'pending' },
  ]);
  const params = new URLSearchParams(seen[0].body);
  assert.equal(seen[0].url, 'https://ec2.us-west-2.amazonaws.com/');
  assert.match(seen[0].auth ?? '', /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/ec2\/aws4_request/);
  assert.equal(seen[0].token, 'session');   // signed as the user's STS session
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
  const id = await awsCloud(env, creds).launch({
    session: 'aaaaaaaaaa', email: 'jdoe@example.org', username: 'jdoe', region: 'r1', userData: '#cloud-config\n',
  });
  assert.equal(id, 'i-9');
  const p = new URLSearchParams(seen[0].body);
  assert.equal(p.get('Action'), 'RunInstances');
  assert.equal(p.get('LaunchTemplate.LaunchTemplateName'), 'annotate-desktop');
  assert.equal(p.get('ClientToken'), 'aaaaaaaaaa');
  assert.equal(atob(p.get('UserData')!), '#cloud-config\n');
  assert.equal(p.get('TagSpecification.1.ResourceType'), 'instance');
  assert.equal(p.get('TagSpecification.1.Tag.1.Key'), 'App');
  assert.equal(p.get('TagSpecification.1.Tag.1.Value'), 'annotate');
  assert.equal(p.get('TagSpecification.1.Tag.2.Value'), 'aaaaaaaaaa');
});

test('EC2 errors surface their code and message', async () => {
  stubFetch(xml(`<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>You are not authorized</Message></Error></Errors></Response>`, 403));
  await assert.rejects(awsCloud(env, creds).terminate(['i-1']), /TerminateInstances failed: UnauthorizedOperation You are not authorized/);
});

test('listMasks() pages through the region\'s masks prefix', async () => {
  const seen = stubFetch(
    xml(`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken>
      <Contents><Key>spida_dev/patches/THM1/masks/jdoe_20260915T101500_masks.tif.gz</Key><LastModified>2026-09-15T10:20:00.000Z</LastModified><Size>1234</Size></Contents>
    </ListBucketResult>`),
    xml(`<ListBucketResult><IsTruncated>false</IsTruncated>
      <Contents><Key>spida_dev/patches/THM1/masks/a&amp;b_20260916T101500_masks.tif.gz</Key><LastModified>2026-09-16T10:20:00.000Z</LastModified><Size>5</Size></Contents>
    </ListBucketResult>`),
  );
  const files = await awsCloud(env, creds).listMasks('THM1');
  assert.deepEqual(files.map((f) => f.key), [
    'spida_dev/patches/THM1/masks/jdoe_20260915T101500_masks.tif.gz',
    'spida_dev/patches/THM1/masks/a&b_20260916T101500_masks.tif.gz',
  ]);
  assert.equal(files[0].size, 1234);
  const first = new URL(seen[0].url);
  assert.equal(first.host, 'annotate-data.s3.us-west-2.amazonaws.com');
  assert.equal(first.searchParams.get('prefix'), 'spida_dev/patches/THM1/masks/');
  assert.equal(new URL(seen[1].url).searchParams.get('continuation-token'), 't2');
});

test('userCredentials() trades the Cognito ID token for AWS credentials in the user\'s name', async () => {
  const seen = stubFetch(xml(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult>
    <Credentials><AccessKeyId>ASIAUSER</AccessKeyId><SecretAccessKey>s3cret</SecretAccessKey>
      <SessionToken>tok</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials>
  </AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`));
  const got = await userCredentials(env, 'k.potts@salk.edu', 'the-id-token');
  assert.equal(got.accessKeyId, 'ASIAUSER');
  assert.equal(got.sessionToken, 'tok');
  assert.equal(seen[0].url, 'https://sts.us-west-2.amazonaws.com/');
  assert.equal(seen[0].auth, null);   // STS takes the ID token itself; no AWS keys involved
  const p = new URLSearchParams(seen[0].body);
  assert.equal(p.get('Action'), 'AssumeRoleWithWebIdentity');
  assert.equal(p.get('RoleArn'), 'arn:aws:iam::020125249408:role/annotate-user');
  assert.equal(p.get('RoleSessionName'), 'k.potts@salk.edu');
  assert.equal(p.get('WebIdentityToken'), 'the-id-token');

  await userCredentials(env, 'k.potts@salk.edu', 'the-id-token');   // cached: no second request
});

test('STS refusals surface their code and message', async () => {
  stubFetch(xml(`<ErrorResponse><Error><Code>InvalidIdentityToken</Code><Message>Incorrect token audience</Message></Error></ErrorResponse>`, 400));
  await assert.rejects(userCredentials(env, 'someone@salk.edu', 'bad'), /InvalidIdentityToken Incorrect token audience/);
});

test('role session names keep only what AWS allows', () => {
  assert.equal(sessionName('k.potts+lab@salk.edu'), 'k.potts+lab@salk.edu');
  assert.equal(sessionName("o'neil@salk.edu"), 'o-neil@salk.edu');
  assert.equal(sessionName(`${'x'.repeat(80)}@salk.edu`).length, 64);
});

test('listFolders() lists subfolders (not masks/) and counts the channel\'s z-slices', async () => {
  const seen = stubFetch(xml(`<ListBucketResult><IsTruncated>false</IsTruncated>
    <Contents><Key>spida_dev/patches/CBDN/region_UWA-7648/fov_07/DAPI_decon_z0.tif</Key><Size>1</Size></Contents>
    <Contents><Key>spida_dev/patches/CBDN/region_UWA-7648/fov_07/DAPI_decon_z1.tif</Key><Size>1</Size></Contents>
    <Contents><Key>spida_dev/patches/CBDN/region_UWA-7648/fov_07/PVALB_decon_z0.tif</Key><Size>1</Size></Contents>
    <Contents><Key>spida_dev/patches/CBDN/region_UWA-7648/fov_07/DAPI_decon_z1.tif.bak</Key><Size>1</Size></Contents>
    <CommonPrefixes><Prefix>spida_dev/patches/CBDN/region_UWA-7648/fov_07/masks/</Prefix></CommonPrefixes>
    <CommonPrefixes><Prefix>spida_dev/patches/CBDN/region_UWA-7648/fov_07/extra/</Prefix></CommonPrefixes>
  </ListBucketResult>`));
  const got = await awsCloud(env, creds).listFolders('CBDN/region_UWA-7648/fov_07');
  assert.deepEqual(got, { folders: ['extra'], images: 2 });
  const url = new URL(seen[0].url);
  assert.equal(url.searchParams.get('prefix'), 'spida_dev/patches/CBDN/region_UWA-7648/fov_07/');
  assert.equal(url.searchParams.get('delimiter'), '/');
});

test('listFolders(\'\') lists the brain regions at the top of the data prefix', async () => {
  const seen = stubFetch(xml(`<ListBucketResult><IsTruncated>false</IsTruncated>
    <CommonPrefixes><Prefix>spida_dev/patches/CBDN/</Prefix></CommonPrefixes>
    <CommonPrefixes><Prefix>spida_dev/patches/THM1/</Prefix></CommonPrefixes>
  </ListBucketResult>`));
  assert.deepEqual(await awsCloud(env, creds).listFolders(''), { folders: ['CBDN', 'THM1'], images: 0 });
  assert.equal(new URL(seen[0].url).searchParams.get('prefix'), 'spida_dev/patches/');
});

const cf = (result: unknown, status = 200) =>
  Response.json({ success: status < 400, errors: status < 400 ? [] : [{ code: 1000, message: 'nope' }], result }, { status });
const zone = (name = 'example.org') => cf([{ id: 'zone', name, account: { id: 'acct' } }]);

// The zone found for a hostname is remembered, so each test uses its own.
let hosts = 0;
const tunnelEnv = (domain = 'example.org') => ({ ...env, DESKTOP_HOSTNAME: `t${++hosts}-{id}.${domain}` }) as Env;

test('create() makes the tunnel, routes it to DCV, adds DNS and returns the token', async () => {
  const seen = stubFetch(zone(), cf({ id: 'tid' }), cf({}), cf({ id: 'rec' }), cf('the-token'));
  const t = await cloudflareTunnels(tunnelEnv()).create('annotate-aaaaaaaaaa', 's-aaaaaaaaaa.example.org');
  assert.deepEqual(t, { id: 'tid', token: 'the-token' });

  assert.deepEqual(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`), [
    'GET /client/v4/zones',
    'POST /client/v4/accounts/acct/cfd_tunnel',
    'PUT /client/v4/accounts/acct/cfd_tunnel/tid/configurations',
    'POST /client/v4/zones/zone/dns_records',
    'GET /client/v4/accounts/acct/cfd_tunnel/tid/token',
  ]);
  assert.equal(new URL(seen[0].url).searchParams.get('name'), 'example.org');
  assert.equal(seen[1].auth, 'Bearer cf-token');
  const ingress = JSON.parse(seen[2].body).config.ingress;
  assert.equal(ingress[0].hostname, 's-aaaaaaaaaa.example.org');
  assert.equal(ingress[0].service, 'https://localhost:8443');
  assert.equal(ingress.at(-1).service, 'http_status:404');
  assert.deepEqual(JSON.parse(seen[3].body), {
    type: 'CNAME', name: 's-aaaaaaaaaa.example.org', content: 'tid.cfargotunnel.com', proxied: true, comment: 'annotate-aaaaaaaaaa',
  });
});

test('remove() deletes only records and tunnels with exactly the session\'s names', async () => {
  const seen = stubFetch(
    zone(),
    // As if the API ignored the name filter and returned everything:
    cf([{ id: 'r-mine', name: 's-aaaaaaaaaa.example.org' }, { id: 'r-www', name: 'www.example.org' }]),
    cf({}),
    cf([{ id: 't-mine', name: 'annotate-aaaaaaaaaa' }, { id: 't-other', name: 'office' }]),
    cf({}),
    cf({}),
  );
  await cloudflareTunnels(tunnelEnv()).remove('annotate-aaaaaaaaaa', 's-aaaaaaaaaa.example.org');
  const deletes = seen.filter((r) => r.method === 'DELETE').map((r) => new URL(r.url).pathname);
  assert.deepEqual(deletes, [
    '/client/v4/zones/zone/dns_records/r-mine',
    '/client/v4/accounts/acct/cfd_tunnel/t-mine/connections',
    '/client/v4/accounts/acct/cfd_tunnel/t-mine',
  ]);
});

test('the zone is the closest parent domain the token can see, and is looked up once', async () => {
  const e = tunnelEnv('desktops.lab.example.org');
  const seen = stubFetch(cf([]), cf([]), zone(), cf({ status: 'healthy' }), cf({ status: 'down' }));
  const tunnels = cloudflareTunnels(e);
  assert.equal(await tunnels.healthy('tid'), true);
  assert.equal(await tunnels.healthy('tid'), false);
  assert.deepEqual(seen.map((r) => new URL(r.url).searchParams.get('name')).slice(0, 3),
    ['desktops.lab.example.org', 'lab.example.org', 'example.org']);
  assert.equal(new URL(seen[3].url).pathname, '/client/v4/accounts/acct/cfd_tunnel/tid');
});

test('a token that can see no zone for the hostname says so', async () => {
  stubFetch(cf([]));
  await assert.rejects(cloudflareTunnels(tunnelEnv('elsewhere.net')).healthy('tid'),
    /can't see a Cloudflare zone for t\d+-….elsewhere.net/);
});

test('tunnel settings are only needed once a tunnel is made', async () => {
  const noDomainYet = { ...env, CF_API_TOKEN: undefined } as Env;
  const tunnels = cloudflareTunnels(noDomainYet);   // must not throw: every request builds this
  await assert.rejects(tunnels.create('annotate-x', 'x.example.org'), /missing configuration: CF_API_TOKEN/);
});

test('Cloudflare errors surface their code and message', async () => {
  stubFetch(zone(), cf(null, 403));
  await assert.rejects(cloudflareTunnels(tunnelEnv()).healthy('tid'), /1000 nope/);
});
