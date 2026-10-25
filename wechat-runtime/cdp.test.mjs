import test from 'node:test';
import assert from 'node:assert/strict';
import { getLoginCode, APP_ID } from './cdp.mjs';

function mockSocket(identity = APP_ID, code = '0' + 'A'.repeat(31)) {
  const calls = [];
  class Socket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    emit(value) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    }
    send(raw) {
      const message = JSON.parse(raw);
      calls.push(message);
      queueMicrotask(() => {
        if (message.method === 'Runtime.enable') {
          this.emit({ method: 'Runtime.executionContextCreated', params: { context: { id: 7 } } });
        }
        const value = message.params.expression?.startsWith('new Promise')
          ? code : { appId: identity, login: true };
        this.emit({ id: message.id, result: { result: { value } } });
      });
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  return { Socket, calls };
}

test('target context returns code and re-enables Runtime', async () => {
  const { Socket, calls } = mockSocket();
  assert.equal(await getLoginCode({ Socket }), '0' + 'A'.repeat(31));
  assert.deepEqual(calls.slice(0, 2).map(call => call.method), ['Runtime.disable', 'Runtime.enable']);
});

test('foreign app context never invokes login', async () => {
  const { Socket, calls } = mockSocket('other-app');
  await assert.rejects(getLoginCode({ Socket }), { code: 'TARGET_NOT_OPEN' });
  assert.equal(calls.some(call => call.params.expression?.startsWith('new Promise')), false);
});

test('missing login code is rejected', async () => {
  const { Socket } = mockSocket(APP_ID, null);
  await assert.rejects(getLoginCode({ Socket }), { code: 'WX_LOGIN_FAILED' });
});
