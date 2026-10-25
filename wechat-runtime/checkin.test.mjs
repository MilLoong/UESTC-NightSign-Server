import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheckin, chinaClock, distanceMeters, validateConfig } from './checkin.mjs';

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
