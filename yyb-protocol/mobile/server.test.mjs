import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileServer } from './server.mjs';

const appToken = 'a'.repeat(43), coreToken = 'b'.repeat(43);
const envelope = (data, status = 200, msg = 'success') => new Response(JSON.stringify({ code: status === 200 ? 0 : status, msg, data }), { status });
async function fixture(t, fetcher) {
  const server = createMobileServer({ appToken, coreToken, coreUrl: 'http://127.0.0.1:18766', fetcher });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options, headers: { Authorization: `Bearer ${appToken}`, ...options.headers },
  });
}

test('legacy administrator QR proxy and code flow', async t => {
  const calls = [];
  const call = await fixture(t, async (url, options) => {
    calls.push({ url, ...options });
    switch (url.pathname) {
      case '/wx/qrcodeauth': return envelope({ session_id: 'qr-1', image_base64: 'data:image/jpeg;base64,YQ==', status: 'pending', private_field: 'omit' });
      case '/wx/qrcodeauth/qr-1/poll': return envelope({ status: 'authorized' });
      case '/wx/qrcodeauth/qr-1/confirm': return envelope({ id: 42, openid: 'omit' });
      case '/wxapp/getCode': return envelope({ result: { code: 'test-code' }, credentials: 'omit' });
    }
    throw new Error('unexpected route');
  });
  const create = await (await call('/wx/qrcodeauth?as_base64=true', { method: 'POST', body: '{}' })).json();
  assert.equal(create.data.session_id, 'qr-1'); assert.equal(create.data.private_field, undefined);
  assert.equal((await (await call('/wx/qrcodeauth/qr-1/poll')).json()).data.status, 'authorized');
  assert.deepEqual((await (await call('/wx/qrcodeauth/qr-1/confirm', { method: 'POST', body: '{}' })).json()).data, { id: 42 });
  const code = await call('/wxapp/getCode', { method: 'POST', body: JSON.stringify({ app_id: 'wxaa78bf2905f01cee', ref: '42', extra: 'strip' }),
    headers: { Cookie: 'school-session=never-forward' } });
  assert.deepEqual((await code.json()).data, { result: { code: 'test-code' } });
  for (const request of calls) {
    assert.equal(request.headers.Authorization, `Bearer ${coreToken}`);
    assert.equal(request.headers.Cookie, undefined);
    assert.equal(request.url.origin, 'http://127.0.0.1:18766');
  }
  assert.deepEqual(JSON.parse(calls.at(-1).body), { app_id: 'wxaa78bf2905f01cee', ref: '42' });
});

test('rejects missing token, browser origin, other APIs and wrong mini app', async t => {
  let calls = 0;
  const call = await fixture(t, async () => { calls++; return envelope({}); });
  assert.equal((await call('/health', { headers: { Authorization: '' } })).status, 401);
  assert.equal((await call('/health', { headers: { Origin: 'https://example.org' } })).status, 401);
  for (const path of ['/accounts', '/wx/getuserinfo', '/wx/qrcodeauth/a/image', '/wx/qrcodeauth/a/poll?x=1']) {
    assert.equal((await call(path)).status, 404);
  }
  assert.equal((await call('/wxapp/getCode', { method: 'POST', body: '{"app_id":"other","ref":"1"}' })).status, 400);
  assert.equal(calls, 0);
});

test('does not expose OAuth secrets in upstream errors', async t => {
  const call = await fixture(t, async () => envelope(null, 502, 'Get https://long.open.weixin.qq.com/?uuid=SECRET: lookup host: no such host'));
  const response = await call('/wx/qrcodeauth/a/poll');
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /DNS lookup failed/); assert.doesNotMatch(body, /SECRET|uuid/);
});

test('upstream connection failure and invalid JSON are bounded errors', async t => {
  let count = 0;
  const call = await fixture(t, async () => {
    if (++count === 1) throw new Error('private upstream details');
    return new Response('not json');
  });
  assert.equal((await call('/health')).status, 502);
  assert.equal((await call('/health')).status, 502);
});
