import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hmacToken, hostnameFor, newSessionId, parseMasksName, REGION_ID, userData, usernameOf,
} from '../src/session.ts';

test('session ids are 10 hostname-safe characters', () => {
  for (let i = 0; i < 100; i++) assert.match(newSessionId(), /^[a-z2-7]{10}$/);
});

test('usernames come from the email and are safe as a file prefix', () => {
  assert.equal(usernameOf('JDoe@Example.org'), 'jdoe');
  assert.equal(usernameOf('jane.o+lab@example.org'), 'jane.o-lab');
  assert.equal(usernameOf('..@example.org'), 'user');
});

test('hostnames need the {id} placeholder', () => {
  assert.equal(hostnameFor('s-{id}.example.org', 'abc'), 's-abc.example.org');
  assert.throws(() => hostnameFor('example.org', 'abc'));
});

test('masks names parse the way open_project.py writes them', () => {
  assert.deepEqual(parseMasksName('jdoe_20260915T101500_masks.tif.gz'), { user: 'jdoe' });
  assert.deepEqual(parseMasksName('first_last_20260915T101500_masks.tif'), { user: 'first_last' });
  assert.equal(parseMasksName('jdoe_20260915T101500_masks.tif.gz.tmp'), null);
  assert.equal(parseMasksName('notes.txt'), null);
});

test('region ids are folders, maybe nested, that cannot climb out', () => {
  for (const ok of ['THM1', 'MTC_REPEAT', 'VePo', 'THM1/patch_03', 'a/b/c']) assert.ok(REGION_ID.test(ok), ok);
  for (const bad of ['', '../secrets', 'THM1/..', 'THM1/.hidden', '/THM1', 'THM1/', 'a//b', 'a b', 'x'.repeat(257)]) {
    assert.ok(!REGION_ID.test(bad), bad);
  }
});

test('tokens are HMAC-SHA256 of the message, base64url', async () => {
  // python3 -c "import hmac,hashlib,base64; print(base64.urlsafe_b64encode(
  //   hmac.new(b'secret', b'abcdefghij', hashlib.sha256).digest()).rstrip(b'='))"
  assert.equal(await hmacToken('secret', 'abcdefghij'), 'MANDtVyZaSU4cui2EQTqHyl6Xr3pEY7wM1z_1K6yyMU');
});

test('user data writes a public and a private env file', () => {
  const out = userData({ REGION: 'region_UCI-5224', RESUME_KEY: '' }, { TUNNEL_TOKEN: 'eyJh+/=' });
  assert.equal(out, `#cloud-config
write_files:
  - path: /etc/annotate/session.env
    permissions: '0644'
    content: |
      REGION=region_UCI-5224
      RESUME_KEY=
  - path: /etc/annotate/secrets.env
    permissions: '0600'
    content: |
      TUNNEL_TOKEN=eyJh+/=
`);
});

test('user data refuses anything a shell or YAML would read differently', () => {
  for (const bad of ['a b', 'a;reboot', '$(id)', 'a\nB=c', '"x"', "'x'", 'a#b']) {
    assert.throws(() => userData({ REGION: bad }, {}), /unsafe/, bad);
  }
  assert.throws(() => userData({ 'lower-case': 'x' }, {}), /unsafe/);
});
