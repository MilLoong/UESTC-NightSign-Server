import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { PairingStore } from './pairing.mjs';
import { createMobileServer } from './server.mjs';
import { createAdminServer } from './admin.mjs';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';

const proof = (token, code, key) => createHmac('sha256', createHash('sha256').update(token).digest())
  .update(`uestc-nightsign-rebind\n${code}\n${key}`).digest('base64url');

test('same installation reuses its device and rotates credentials without losing authorization', () => {
  const store = new PairingStore(), key = 'k'.repeat(43);
  const first = store.claim(store.offer('https://one.example.org').code, { installationKey: key });
  store.grant(first.device_id, 42);
  const second = store.claim(store.offer('https://two.example.org').code, { installationKey: key });
  assert.equal(second.device_id, first.device_id);
  assert.equal(second.ref, '42');
  assert.equal(store.devices.length, 1);
  assert.equal(store.authenticate(first.token), null);
  assert.deepEqual(store.authenticate(second.token).accounts, ['42']);
  assert.equal(JSON.stringify(store.devices).includes(key), false);
});

test('legacy binding migrates using challenge proof rather than revealing the previous token', () => {
  const store = new PairingStore(), key = 'k'.repeat(43);
  const old = store.claim(store.offer('https://old.example.org').code);
  store.grant(old.device_id, 42);
  const offer = store.offer('https://new.example.org');
  const migrated = store.claim(offer.code, { installationKey: key, previousProof: proof(old.token, offer.code, key) });
  assert.equal(migrated.device_id, old.device_id);
  assert.equal(store.devices.length, 1);
  assert.deepEqual(store.authenticate(migrated.token).accounts, ['42']);
});

test('different installations remain distinct and a revoked installation must reauthorize', () => {
  const store = new PairingStore(), key = 'k'.repeat(43);
  const first = store.claim(store.offer('https://example.org').code, { installationKey: key });
  const other = store.claim(store.offer('https://example.org').code, { installationKey: 'z'.repeat(43) });
  assert.notEqual(first.device_id, other.device_id);
  store.grant(first.device_id, 42);
  store.revoke(first.device_id);
  const again = store.claim(store.offer('https://example.org').code, { installationKey: key });
  assert.equal(again.device_id, first.device_id);
  assert.deepEqual(store.authenticate(again.token).accounts, []);
});

test('only proof of both identities can merge two existing records', () => {
  const store = new PairingStore(), key = 'k'.repeat(43);
  const first = store.claim(store.offer('https://example.org').code, { installationKey: key });
  const legacy = store.claim(store.offer('https://example.org').code);
  store.grant(first.device_id, 42); store.grant(legacy.device_id, 84);
  const offer = store.offer('https://example.org');
  const merged = store.claim(offer.code, { installationKey: key, previousProof: proof(legacy.token, offer.code, key) });
  assert.equal(merged.device_id, first.device_id);
  assert.deepEqual(merged.merged_device_ids, [legacy.device_id]);
  assert.equal(store.list().filter(item => !item.revoked).length, 1);
  assert.deepEqual(store.authenticate(merged.token).accounts.sort(), ['42', '84']);
  assert.equal(store.authenticate(legacy.token), null);
});

test('a failed repeat binding rolls back credentials and keeps the code retryable', () => {
  const store = new PairingStore(), key = 'k'.repeat(43);
  const first = store.claim(store.offer('https://example.org').code, { installationKey: key });
  const offer = store.offer('https://example.org');
  const save = store.save;
  store.save = () => { throw new Error('disk unavailable'); };
  assert.throws(() => store.claim(offer.code, { installationKey: key }));
  assert.equal(store.devices.length, 1);
  assert.ok(store.authenticate(first.token));
  store.save = save;
  assert.equal(store.claim(offer.code, { installationKey: key }).device_id, first.device_id);
});

test('pair API reuses installation identity and rejects the old credential after rotation', async t => {
  const pairing = new PairingStore(), key = 'k'.repeat(43);
  const server = createMobileServer({ appToken: 'a'.repeat(43), coreToken: 'b'.repeat(43), coreUrl: 'http://127.0.0.1:18766', pairing });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pair = async previous => {
    const offer = pairing.offer('https://example.org');
    const body = { code: offer.code, installation_key: key };
    if (previous) body.previous_proof = proof(previous.token, offer.code, key);
    const response = await fetch(base + '/v1/pair', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  const first = await pair();
  const second = await pair(first);
  assert.equal(first.device_id, second.device_id);
  assert.equal(pairing.list().filter(item => !item.revoked).length, 1);
  assert.equal((await fetch(base + '/v1/device', { headers: { Authorization: `Bearer ${first.token}` } })).status, 401);
  assert.equal((await fetch(base + '/v1/device', { headers: { Authorization: `Bearer ${second.token}` } })).status, 200);
});

test('one-use pairing expires, multiple tabs coexist, and stores only token hashes', () => {
  let now = 1000;
  const store = new PairingStore(undefined, () => now);
  assert.throws(() => store.offer('http://example.org'));
  const old = store.offer('https://example.org').code;
  const offer = store.offer('https://example.org');
  assert.ok(store.claim(old));
  const claimed = store.claim(offer.code);
  assert.ok(claimed.token); assert.equal(store.claim(offer.code), null);
  assert.equal(JSON.stringify(store.devices).includes(claimed.token), false);
  const expired = store.offer('https://example.org').code;
  now += 120_001;
  assert.equal(store.claim(expired), null);
});

test('opening a second page does not expire the first QR and outstanding offers are bounded', () => {
  const store = new PairingStore();
  const first = store.offer('https://example.org');
  store.offer('https://example.org');
  assert.ok(store.claim(first.code));
  for (let i = 0; i < 50; i++) store.offer('https://example.org');
  assert.equal(store.pairs.size, 32);
});

test('device ownership and revocation persist across server restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightsign-pair-'));
  try {
    let store = new PairingStore(dir);
    const serverId = store.serverId;
    const device = store.claim(store.offer('https://example.org').code);
    store.grant(device.device_id, 42);
    store = new PairingStore(dir);
    assert.equal(store.offer('https://new-tunnel.example.org').server_id, serverId);
    assert.deepEqual(store.authenticate(device.token).accounts, ['42']);
    assert.equal(readFileSync(join(dir, 'devices.json'), 'utf8').includes(device.token), false);
    store.revoke(device.device_id);
    assert.equal(new PairingStore(dir).authenticate(device.token), null);
  } finally {
    assert.equal(dirname(realpathSync(dir)), realpathSync(tmpdir()));
    assert.ok(basename(dir).startsWith('nightsign-pair-'));
    rmSync(dir, { recursive: true });
  }
});

test('device cannot access another QR or forge account ownership', async t => {
  const pairing = new PairingStore();
  const first = pairing.claim(pairing.offer('https://example.org').code);
  const second = pairing.claim(pairing.offer('https://example.org').code);
  let calls = 0;
  const server = createMobileServer({ appToken: 'a'.repeat(43), coreToken: 'b'.repeat(43), coreUrl: 'http://127.0.0.1:18766', pairing,
    fetcher: async url => {
      calls++;
      const data = url.pathname === '/wx/qrcodeauth' ? { session_id: 'private-qr', image_base64: 'data:image/jpeg;base64,YQ==' } :
        url.pathname.endsWith('/confirm') ? { id: 42 } : url.pathname.endsWith('/poll') ? { status: 'authorized' } : { result: { code: 'only-own-code' } };
      return new Response(JSON.stringify({ code: 0, data }));
    } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = (device, path, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, body, headers: { Authorization: `Bearer ${device.token}` },
  });
  assert.equal((await call(first, '/wx/qrcodeauth?as_base64=true', 'POST', '{}')).status, 404);
  assert.equal((await call(second, '/wx/qrcodeauth/private-qr/poll')).status, 404);
  assert.equal(calls, 0);
  await server.authorization.start(first.device_id).done;
  assert.equal(server.authorizationViews()[0].image, null);
  assert.equal(calls, 3);
  assert.equal((await (await call(first, '/v1/device')).json()).data.ref, '42');
  assert.equal((await (await call(second, '/v1/device')).json()).data.ref, null);
  const payload = JSON.stringify({ app_id: 'wxaa78bf2905f01cee', ref: '42' });
  assert.equal((await call(second, '/wxapp/getCode', 'POST', payload)).status, 403);
  assert.equal((await call(first, '/wxapp/getCode', 'POST', payload)).status, 200);
  assert.equal((await call(first, '/v1/device', 'DELETE')).status, 200);
  assert.equal((await call(first, '/health')).status, 401);
  assert.deepEqual(server.authorizationViews(), []);
});

test('public pairing claims once and never exposes the local management page', async t => {
  const pairing = new PairingStore();
  const offer = pairing.offer('https://example.org');
  const server = createMobileServer({ appToken: 'a'.repeat(43), coreToken: 'b'.repeat(43), coreUrl: 'http://127.0.0.1:18766', pairing });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pair = () => fetch(base + '/v1/pair', { method: 'POST', body: JSON.stringify({ code: offer.code }) });
  const results = await Promise.all([pair(), pair()]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  const issued = (await results.find(r => r.status === 200).json()).data;
  assert.equal((await fetch(base + '/dev/wechat', { headers: { Authorization: `Bearer ${issued.token}` } })).status, 404);
  assert.notEqual((await fetch(base + '/dev/pair')).status, 200);
  assert.equal((await fetch(base + '/v1/pair', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 401);
});

test('management page has a QR, rejects DNS rebinding and requires CSRF for revoke', async t => {
  const pairing = new PairingStore();
  const device = pairing.claim(pairing.offer('https://example.org').code);
  let started = null;
  const admin = createAdminServer(pairing, () => 'https://example.org', () => [{ device: 'test-device', status: 'pending', image: 'data:image/jpeg;base64,YQ==' }],
    { start: id => { started = id; }, cancel: () => {} });
  await new Promise(resolve => admin.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { admin.closeAllConnections(); admin.close(resolve); }));
  const base = `http://127.0.0.1:${admin.address().port}`;
  const rebinding = await new Promise((resolve, reject) => {
    http.get(base + '/dev/pair', { headers: { Host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(rebinding, 403);
  const page = await (await fetch(base + '/dev/pair')).text();
  assert.match(page, /http-equiv="refresh" content="90"/);
  assert.match(page, /<svg/); assert.doesNotMatch(page, /a{43}/);
  assert.match(page, /src="\/dev\/wechat"/);
  const frame = await (await fetch(base + '/dev/wechat')).text();
  assert.match(frame, /data:image\/jpeg;base64,YQ==/);
  assert.match(frame, /http-equiv="refresh" content="3"/);
  assert.equal((await fetch(base + '/dev/revoke', { method: 'POST', body: `device=${device.device_id}` })).status, 403);
  const csrf = page.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)[1];
  assert.equal((await fetch(base + '/dev/authorize', { method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ device: device.device_id, csrf }) })).status, 303);
  assert.equal(started, device.device_id);
  assert.equal((await fetch(base + '/dev/revoke', { method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ device: device.device_id, csrf }) })).status, 303);
  assert.equal(pairing.authenticate(device.token), null);
});
