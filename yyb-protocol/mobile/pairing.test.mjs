import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { PairingStore } from './pairing.mjs';
import { createMobileServer } from './server.mjs';
import { createAdminServer } from './admin.mjs';
import http from 'node:http';

test('one-use pairing expires, refresh retires old codes, and stores only token hashes', () => {
  let now = 1000;
  const store = new PairingStore(undefined, () => now);
  assert.throws(() => store.offer('http://example.org'));
  const old = store.offer('https://example.org').code;
  const offer = store.offer('https://example.org');
  assert.equal(store.claim(old), null);
  const claimed = store.claim(offer.code);
  assert.ok(claimed.token); assert.equal(store.claim(offer.code), null);
  assert.equal(JSON.stringify(store.devices).includes(claimed.token), false);
  const expired = store.offer('https://example.org').code;
  now += 120_001;
  assert.equal(store.claim(expired), null);
});

test('device ownership and revocation persist across server restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightsign-pair-'));
  try {
    let store = new PairingStore(dir);
    const device = store.claim(store.offer('https://example.org').code);
    store.grant(device.device_id, 42);
    store = new PairingStore(dir);
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
        url.pathname.endsWith('/confirm') ? { id: 42 } : { result: { code: 'only-own-code' } };
      return new Response(JSON.stringify({ code: 0, data }));
    } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = (device, path, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, body, headers: { Authorization: `Bearer ${device.token}` },
  });
  assert.equal((await call(first, '/wx/qrcodeauth?as_base64=true', 'POST', '{}')).status, 200);
  assert.equal((await call(second, '/wx/qrcodeauth/private-qr/poll')).status, 404);
  assert.equal(calls, 1);
  assert.equal((await call(first, '/wx/qrcodeauth/private-qr/confirm', 'POST', '{}')).status, 200);
  assert.equal((await call(first, '/wx/qrcodeauth/private-qr/confirm', 'POST', '{}')).status, 200);
  assert.equal(calls, 2); // A lost confirmation response does not repeat the upstream exchange.
  const payload = JSON.stringify({ app_id: 'wxaa78bf2905f01cee', ref: '42' });
  assert.equal((await call(second, '/wxapp/getCode', 'POST', payload)).status, 403);
  assert.equal((await call(first, '/wxapp/getCode', 'POST', payload)).status, 200);
  assert.equal((await call(first, '/v1/device', 'DELETE')).status, 200);
  assert.equal((await call(first, '/health')).status, 401);
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
  assert.notEqual((await fetch(base + '/dev/pair')).status, 200);
  assert.equal((await fetch(base + '/v1/pair', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 401);
});

test('management page has a QR, rejects DNS rebinding and requires CSRF for revoke', async t => {
  const pairing = new PairingStore();
  const device = pairing.claim(pairing.offer('https://example.org').code);
  const admin = createAdminServer(pairing, () => 'https://example.org');
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
  assert.match(page, /<svg/); assert.doesNotMatch(page, /a{43}/);
  assert.equal((await fetch(base + '/dev/revoke', { method: 'POST', body: `device=${device.device_id}` })).status, 403);
  const csrf = page.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)[1];
  assert.equal((await fetch(base + '/dev/revoke', { method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ device: device.device_id, csrf }) })).status, 303);
  assert.equal(pairing.authenticate(device.token), null);
});
