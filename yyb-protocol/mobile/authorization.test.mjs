import test from 'node:test';
import assert from 'node:assert/strict';
import { PairingStore } from './pairing.mjs';
import { WechatAuthorization, AuthorizationError } from './authorization.mjs';

function fixture(call) {
  const pairing = new PairingStore();
  const device = pairing.claim(pairing.offer('https://example.org').code);
  const authorization = new WechatAuthorization(pairing, call, async () => {});
  return { pairing, device, authorization };
}
const qr = { session_id: 'server-qr', image_base64: 'data:image/jpeg;base64,YQ==' };

test('server generates, polls and saves without an app QR request', async () => {
  let polls = 0, confirms = 0;
  const { device, authorization } = fixture(async path => {
    if (path.includes('as_base64')) return qr;
    if (path.endsWith('/poll')) return { status: ++polls === 1 ? 'scanned' : 'authorized' };
    if (path.endsWith('/confirm')) { confirms++; return { id: 42 }; }
    return {};
  });
  await authorization.start(device.device_id).done;
  assert.equal(confirms, 1);
  assert.deepEqual(authorization.status(device.device_id), { authorized: true, ref: '42', status: 'confirmed' });
  assert.equal(authorization.views()[0].image, null);
});

test('transient poll and not-ready confirmation recover on the server', async () => {
  let polls = 0, confirms = 0;
  const { device, authorization } = fixture(async path => {
    if (path.includes('as_base64')) return qr;
    if (path.endsWith('/poll')) {
      if (++polls === 1) throw new AuthorizationError('网络暂时不可用', true);
      return { status: 'authorized' };
    }
    if (path.endsWith('/confirm')) {
      if (++confirms === 1) throw new AuthorizationError('尚未就绪', true);
      return { id: 42 };
    }
    return {};
  });
  await authorization.start(device.device_id).done;
  assert.equal(authorization.status(device.device_id).authorized, true);
  assert.equal(confirms, 2);
});

test('revocation during an in-flight exchange cannot grant an account', async () => {
  let resolveConfirm;
  let atConfirm;
  const reached = new Promise(resolve => { atConfirm = resolve; });
  const { pairing, device, authorization } = fixture(async path => {
    if (path.includes('as_base64')) return qr;
    if (path.endsWith('/poll')) return { status: 'authorized' };
    if (path.endsWith('/confirm')) { atConfirm(); return new Promise(resolve => { resolveConfirm = resolve; }); }
    return {};
  });
  const job = authorization.start(device.device_id);
  await reached;
  pairing.revoke(device.device_id);
  authorization.cancel(device.device_id);
  resolveConfirm({ id: 42 });
  await job.done;
  assert.deepEqual(pairing.devices[0].accounts, []);
  assert.deepEqual(authorization.views(), []);
});

test('expired QR does not save authorization and unexpected errors do not leak secrets', async () => {
  const { device, authorization } = fixture(async path => path.includes('as_base64') ? qr : { status: 'expired' });
  await authorization.start(device.device_id).done;
  assert.equal(authorization.status(device.device_id).status, 'expired');
  assert.equal(authorization.status(device.device_id).authorized, false);
  const failed = fixture(async () => { throw new Error('SECRET_OAUTH_URL'); });
  await failed.authorization.start(failed.device.device_id).done;
  assert.equal(JSON.stringify(failed.authorization.views()).includes('SECRET'), false);
});

test('a replaced creation cannot overwrite the new authorization', async () => {
  let resolveOld;
  let creates = 0;
  const cancelled = [];
  const { device, authorization } = fixture(async path => {
    if (path.includes('as_base64')) {
      if (++creates === 1) return new Promise(resolve => { resolveOld = resolve; });
      return { ...qr, session_id: 'new-qr' };
    }
    if (path.endsWith('/poll')) return { status: 'authorized' };
    if (path.endsWith('/confirm')) return { id: 42 };
    if (path.endsWith('/cancel')) cancelled.push(path);
    return {};
  });
  const old = authorization.start(device.device_id);
  await authorization.start(device.device_id).done;
  resolveOld({ ...qr, session_id: 'old-qr' });
  await old.done;
  assert.equal(authorization.status(device.device_id).status, 'confirmed');
  assert.equal(authorization.status(device.device_id).ref, '42');
  assert.ok(cancelled.includes('/wx/qrcodeauth/old-qr/cancel'));
});
