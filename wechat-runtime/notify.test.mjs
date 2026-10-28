import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notification, sendNotification } from './notify.mjs';

test('notifications do not forward arbitrary errors or credentials', () => {
  const text = JSON.stringify(notification({ error: 'secret', businessDate: 'secret', stage: 'secret' }));
  assert.ok(!text.includes('secret'));
  assert.match(notification({ stage: 'result_unknown' }).title, /不确定/);
  assert.match(notification({ stage: 'notification_test' }).title, /未执行签到/);
});

test('optional config, bounded push and sanitized failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nightsign-notify-'));
  const path = join(directory, 'notify.json');
  try {
    assert.equal((await sendNotification({}, { path })).notification, 'disabled');
    await writeFile(path, JSON.stringify({ sendKey: 'SCT' + 'x'.repeat(20) }));
    let calls = 0;
    const fetcher = async (url, options) => {
      calls++;
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      return { ok: true, json: async () => ({ code: 0 }) };
    };
    assert.equal((await sendNotification({}, { path, fetcher })).notification, 'accepted');
    assert.equal(calls, 1);
    const failed = await sendNotification({}, { path, fetcher: async () => { throw Error('secret'); } });
    assert.deepEqual(failed, { notification: 'failed' });
  } finally { await rm(directory, { recursive: true }); }
});
