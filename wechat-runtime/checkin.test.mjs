import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheckin, chinaClock, distanceMeters, validateConfig, schoolClient, isSessionInvalid, JobError } from './checkin.mjs';

const config = { latitude: 31, longitude: 121, coordinateSystemCode: 'gcj02' };
const now = () => new Date('2026-10-25T13:30:00Z');

function fixture({ checked = false, postThrows = false, outside = false, recorded = false } = {}) {
  const calls = [], ledgerData = recorded ? { '2026-10-25': { stage: 'sending' } } : {};
  let postCount = 0, loginCount = 0;
  return { config, now, calls, ledgerData,
    login: async () => { loginCount++; return '0' + 'A'.repeat(31); },
    getLoginCount: () => loginCount,
    ledger: { get: day => ledgerData[day], put: async (day, entry) => { ledgerData[day] = entry; } },
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (path.endsWith('/today')) return { businessDate: '2026-10-25', recordStatusCode: checked || postCount ? 'CHECKED_IN' : 'PENDING' };
      if (path.endsWith('/effective')) return { effective: true, studentCheckinStartOffsetMinute: 1260, studentCheckinEndOffsetMinute: 1410 };
      if (path.endsWith('/available-locations')) return [{ latitude: 31.0005, longitude: 121, radiusMeter: outside ? 1 : 140 }];
      if (path.includes('/map/reverse')) return 'fixture address';
      if (path.endsWith('/checkin-ticket')) return { ticket: 'T'.repeat(43) };
      if (path.endsWith('/checkin')) {
        assert.equal(ledgerData['2026-10-25'].stage, 'sending');
        postCount++;
        if (postThrows) throw new Error('network timeout');
        return true;
      }
      throw new Error('unexpected path');
    } };
}

test('clock uses Shanghai independently of host timezone', () => {
  assert.deepEqual(chinaClock(now()), { date: '2026-10-25', minute: 1290, timestamp: '2026-10-25 21:30:00' });
});
test('configured point is within school range', () => {
  const distance = distanceMeters(config, { latitude: 31.0005, longitude: 121 });
  assert.ok(distance > 50 && distance < 60);
});
test('invalid coordinates and coordinate system rejected', () => {
  assert.throws(() => validateConfig({ ...config, latitude: NaN }));
  assert.throws(() => validateConfig({ ...config, coordinateSystemCode: 'wgs84' }));
});
test('verification exchanges ticket without submitting check-in', async () => {
  const f = fixture();
  const result = await runCheckin(f);
  assert.equal(result.stage, 'authorization_verified');
  assert.equal(f.calls.filter(c => c.path.endsWith('/checkin')).length, 0);
  assert.deepEqual(f.ledgerData, {});
});
test('already checked in does not request code', async () => {
  const f = fixture({ checked: true });
  const result = await runCheckin({ ...f, submit: true });
  assert.equal(result.stage, 'already_checked_in');
  assert.equal(f.getLoginCount(), 0);
});
test('outside time window never submits', async () => {
  const f = fixture();
  await assert.rejects(runCheckin({ ...f, submit: true, now: () => new Date('2026-10-25T06:00:00Z') }), { code: 'OUTSIDE_CHECKIN_WINDOW' });
  assert.equal(f.getLoginCount(), 0);
});
test('outside assigned location never requests code', async () => {
  const f = fixture({ outside: true });
  await assert.rejects(runCheckin({ ...f, submit: true }), { code: 'OUTSIDE_ALLOWED_LOCATION' });
  assert.equal(f.getLoginCount(), 0);
});
test('successful submit is confirmed with today query', async () => {
  const f = fixture();
  const result = await runCheckin({ ...f, submit: true });
  assert.equal(result.stage, 'checked_in_confirmed');
  assert.equal(f.calls.filter(c => c.path.endsWith('/checkin')).length, 1);
  assert.equal(f.ledgerData['2026-10-25'].stage, 'checked_in_confirmed');
  const payload = f.calls.find(c => c.path.endsWith('/checkin')).options.body;
  assert.equal(payload.longitude, config.longitude);
  assert.equal(payload.accuracy, 0);
  assert.equal(payload.locationEnabled, false);
});
test('timed out submit only queries, never resubmits', async () => {
  const f = fixture({ postThrows: true });
  assert.equal((await runCheckin({ ...f, submit: true })).stage, 'checked_in_confirmed');
  assert.equal(f.calls.filter(c => c.path.endsWith('/checkin')).length, 1);
});
test('previous attempt blocks automatic second submission', async () => {
  const f = fixture({ recorded: true });
  await assert.rejects(runCheckin({ ...f, submit: true }), { code: 'ATTEMPT_ALREADY_RECORDED' });
  assert.equal(f.getLoginCount(), 0);
});

// --- school session self-healing -------------------------------------------

const code = '0' + 'A'.repeat(31);
const wechat = (sid = null) => ({ sid, login: async () => code, rememberSessionId: async () => {} });

function responder(overrides = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const route = Object.keys(overrides).find(key => url.endsWith(key)) || 'default';
    const reply = typeof overrides[route] === 'function' ? overrides[route](requests.length) : overrides[route];
    return reply || { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, ok: true, data: {} }) };
  };
  return { requests, fetchImpl };
}

test('missing session is rebuilt with wx.login + check-bind', async () => {
  const { requests, fetchImpl } = responder({
    '/check-bind': { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, ok: true, data: { bind: true, sessionId: 'S'.repeat(20) } }) },
  });
  const client = schoolClient(wechat(), { fetch: fetchImpl });
  await client.request('/daily-checkin/api/student-checkin-record/today');
  assert.match(requests[0].url, /\/platform-app\/api\/auth\/check-bind$/);
  assert.equal(JSON.parse(requests[0].init.body).sn, '');
  assert.equal(requests[0].init.headers.platform, 'mp-weixin');
  assert.equal('Cookie' in requests[0].init.headers, false);
  assert.equal(requests[1].init.headers.Cookie, 'SESSION=' + 'S'.repeat(20));
});

test('stale SESSION is refreshed once and the GET repeated', async () => {
  let todayCalls = 0;
  const { fetchImpl } = responder({
    '/check-bind': { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, ok: true, data: { bind: true, sessionId: 'N'.repeat(20) } }) },
    '/today': () => {
      todayCalls++;
      return todayCalls === 1
        ? { ok: false, status: 401, text: async () => '' }
        : { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, ok: true, data: { recordStatusCode: 'CHECKED_IN' } }) };
    },
  });
  const client = schoolClient(wechat('O'.repeat(20)), { fetch: fetchImpl });
  const data = await client.request('/daily-checkin/api/student-checkin-record/today');
  assert.equal(data.recordStatusCode, 'CHECKED_IN');
  assert.equal(todayCalls, 2);
});

test('unbound account stops with WECHAT_NOT_BOUND', async () => {
  const { fetchImpl } = responder({
    '/check-bind': { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, ok: true, data: { bind: false } }) },
  });
  const client = schoolClient(wechat(), { fetch: fetchImpl });
  await assert.rejects(client.request('/x'), { code: 'WECHAT_NOT_BOUND' });
});

test('non-session failures are never retried', async () => {
  const { requests, fetchImpl } = responder({
    default: { ok: false, status: 500, text: async () => '' },
  });
  const client = schoolClient(wechat('O'.repeat(20)), { fetch: fetchImpl });
  await assert.rejects(client.request('/x'), { code: 'HTTP_500' });
  assert.equal(requests.length, 1);
});

test('session-invalid classification covers 401, 4001 and 5000-with-hint', () => {
  assert.equal(isSessionInvalid(new JobError('HTTP_401')), true);
  assert.equal(isSessionInvalid(new JobError('PLATFORM_4001')), true);
  assert.equal(isSessionInvalid(new JobError('PLATFORM_5000', '用户未登录')), true);
  assert.equal(isSessionInvalid(new JobError('PLATFORM_5000', '系统繁忙')), false);
  assert.equal(isSessionInvalid(new Error('boom')), false);
});

test('legacy session-string client keeps sending the given cookie', async () => {
  const { requests, fetchImpl } = responder();
  const client = schoolClient('L'.repeat(20), { fetch: fetchImpl });
  await client.request('/x');
  assert.equal(requests[0].init.headers.Cookie, 'SESSION=' + 'L'.repeat(20));
});
