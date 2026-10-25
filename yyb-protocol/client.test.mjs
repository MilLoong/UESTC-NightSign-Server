import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_ID, getYybCode, validateSettings, verifyTicket } from './client.mjs';

const settings = { endpoint: 'http://127.0.0.1:18766', token: 'A'.repeat(43), ref: '1' };
const code = '0' + 'B'.repeat(31);
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('binds target app and only sends protocol credentials to YYB', async () => {
  const result = await getYybCode(settings, async (url, options) => {
    assert.equal(url.pathname, '/wxapp/getCode');
    assert.deepEqual(JSON.parse(options.body), { ref: '1', app_id: APP_ID });
    assert.equal(options.headers.Authorization, `Bearer ${settings.token}`);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.redirect, 'error');
    return json({ result: { code } });
  });
  assert.equal(result, code);
});
test('remote HTTP and credential-bearing URLs are rejected', () => {
  for (const endpoint of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?secret=x']) {
    assert.throws(() => validateSettings({ ...settings, endpoint }));
  }
});
test('missing token or account rejected before requesting', async () => {
  for (const value of [{ ...settings, token: '' }, { ...settings, ref: '' }]) {
    await assert.rejects(getYybCode(value, () => { throw new Error('must not call'); }));
  }
});
test('HTTP failures do not echo remote messages', async () => {
  await assert.rejects(getYybCode(settings, async () => new Response('secret-session', { status: 502 })), { code: 'YYB_HTTP_502' });
});
test('invalid code and oversized responses rejected', async () => {
  await assert.rejects(getYybCode(settings, async () => json({ result: { code: 'bad' } })), { code: 'YYB_CODE_INVALID' });
  await assert.rejects(getYybCode(settings, async () => new Response('A'.repeat(4097))), { code: 'YYB_RESPONSE_TOO_LARGE' });
});
test('ticket-only flow sends school cookie only to school and never checks in', async () => {
  const urls = [];
  const result = await verifyTicket({ settings, session: 'fixture_school_session_123456' }, async (url, options) => {
    urls.push(String(url));
    if (urls.length === 1) return json({ result: { code } });
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, 'SESSION=fixture_school_session_123456');
    assert.deepEqual(JSON.parse(options.body), { code });
    return json({ code: 0, data: { ticket: 'T'.repeat(43) } });
  });
  assert.equal(urls.length, 2);
  assert.equal(result.checkinSubmitted, false);
  assert.equal(result.ticketLength, 43);
  assert.equal(JSON.stringify(result).includes(code), false);
});
