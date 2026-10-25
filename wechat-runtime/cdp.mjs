export const APP_ID = 'wxaa78bf2905f01cee';
export const CODE_PATTERN = /^[A-Za-z0-9_-]{24,128}$/;

export class BrokerError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}

export class CdpSession {
  constructor(socket, timeoutMs = 15000) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.contexts = new Set();
    this.pending = new Map();
    this.sequence = 0;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.method === 'Runtime.executionContextCreated') this.contexts.add(message.params.context.id);
      if (message.method === 'Runtime.executionContextDestroyed') this.contexts.delete(message.params.executionContextId);
      if (message.method === 'Runtime.executionContextsCleared') this.contexts.clear();
      const call = this.pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer);
      this.pending.delete(message.id);
      if (message.error) call.reject(new BrokerError('CDP_COMMAND_FAILED'));
      else call.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectPending());
    socket.addEventListener('error', () => this.rejectPending());
  }

  rejectPending() {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new BrokerError('CDP_DISCONNECTED'));
    }
    this.pending.clear();
  }

  command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrokerError('CDP_TIMEOUT'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new BrokerError('CDP_DISCONNECTED')); }
    });
  }

  async evaluate(contextId, expression) {
    const response = await this.command('Runtime.evaluate', {
      contextId, expression, awaitPromise: true, returnByValue: true,
    });
    if (response.exceptionDetails) throw new BrokerError('CDP_EXPRESSION_FAILED');
    return response.result?.value;
  }

  close() { this.rejectPending(); this.socket.close(); }
}

export async function getLoginCode({ Socket = WebSocket, timeoutMs = 15000 } = {}) {
  const socket = new Socket('ws://127.0.0.1:62000');
  const session = new CdpSession(socket, timeoutMs);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new BrokerError('CDP_CONNECT_TIMEOUT')), timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new BrokerError('CDP_UNAVAILABLE')); }, { once: true });
    });
    // WMPF keeps Runtime enabled across proxy reconnects; re-enable to replay contexts.
    await session.command('Runtime.disable');
    await session.command('Runtime.enable');
    let target;
    for (const id of session.contexts) {
      const identity = await session.evaluate(id, `(() => { try {
        return { appId: wx.getAccountInfoSync().miniProgram.appId, login: typeof wx.login === 'function' };
      } catch (_) { return null; } })()`).catch(() => null);
      if (identity?.appId === APP_ID && identity.login) { target = id; break; }
    }
    if (target === undefined) throw new BrokerError('TARGET_NOT_OPEN');
    const code = await session.evaluate(target, `new Promise(resolve => {
      if (wx.getAccountInfoSync().miniProgram.appId !== '${APP_ID}') { resolve(null); return; }
      wx.login({ timeout: 10000, success: r => resolve(r.code || null), fail: () => resolve(null) });
    })`);
    if (typeof code !== 'string' || !CODE_PATTERN.test(code)) throw new BrokerError('WX_LOGIN_FAILED');
    return code;
  } finally { session.close(); }
}
