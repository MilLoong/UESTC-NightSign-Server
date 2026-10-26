import { setTimeout as sleep } from 'node:timers/promises';

export class AuthorizationError extends Error {
  constructor(message, retryable = false) { super(message); this.retryable = retryable; }
}

export class WechatAuthorization {
  constructor(pairing, call, pause = (ms, signal) => sleep(ms, undefined, { signal })) {
    this.pairing = pairing;
    this.call = call;
    this.pause = pause;
    this.jobs = new Map();
  }
  device(id) { return this.pairing.devices.find(item => item.id === id && !item.revoked); }
  start(id) {
    if (!this.device(id)) throw new Error('DEVICE_NOT_FOUND');
    this.cancel(id);
    const controller = new AbortController();
    const job = { id, controller, status: 'creating', image: null, message: '', session: null };
    this.jobs.set(id, job);
    job.done = this.run(job);
    return job;
  }
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.status === 'confirmed') return;
    job.controller.abort();
    job.status = 'cancelled'; job.image = null;
    if (job.session) this.call(`/wx/qrcodeauth/${job.session}/cancel`, 'POST', AbortSignal.timeout(5000)).catch(() => {});
  }
  active(job, signal) {
    signal.throwIfAborted();
    if (this.jobs.get(job.id) !== job || !this.device(job.id)) throw new Error('DEVICE_REVOKED');
  }
  async retry(job, path, method, signal) {
    for (let attempt = 1; ; attempt++) {
      this.active(job, signal);
      try { return await this.call(path, method, signal); }
      catch (error) {
        this.active(job, signal);
        if (error instanceof AuthorizationError && !error.retryable) throw error;
        job.message = error instanceof AuthorizationError ? error.message + '，正在重试' : '连接暂时中断，正在重试';
        await this.pause(Math.min(2000 * attempt, 10_000), signal);
      }
    }
  }
  async run(job) {
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(300_000)]);
    try {
      const qr = await this.call('/wx/qrcodeauth?as_base64=true', 'POST', signal);
      // Keep the ID for cancellation even if the user replaced the job while creation was in flight.
      if (/^[A-Za-z0-9_-]{1,128}$/.test(qr?.session_id || '')) job.session = qr.session_id;
      this.active(job, signal);
      if (!job.session || !/^data:image\/(jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$/.test(qr?.image_base64 || '')) {
        throw new AuthorizationError('协议核心返回的二维码无效');
      }
      job.image = qr.image_base64; job.status = 'pending';
      while (true) {
        const result = await this.retry(job, `/wx/qrcodeauth/${job.session}/poll`, 'GET', signal);
        this.active(job, signal);
        job.message = '';
        if (['authorized', 'confirmed'].includes(result.status)) {
          job.status = 'authorized';
          const account = await this.retry(job, `/wx/qrcodeauth/${job.session}/confirm`, 'POST', signal);
          this.active(job, signal);
          if (!Number.isSafeInteger(account?.id) || account.id <= 0) throw new AuthorizationError('微信授权账号无效');
          this.pairing.grant(job.id, account.id);
          job.status = 'confirmed'; job.image = null; job.message = '';
          return;
        }
        if (['expired', 'cancelled', 'unknown'].includes(result.status)) {
          job.status = result.status === 'cancelled' ? 'cancelled' : 'expired'; job.image = null; return;
        }
        if (!['pending', 'scanned'].includes(result.status)) throw new AuthorizationError('扫码状态响应无效');
        job.status = result.status;
        await this.pause(1000, signal);
      }
    } catch (error) {
      if (job.controller.signal.aborted) job.status = 'cancelled';
      else if (signal.aborted) job.status = 'expired';
      else { job.status = 'error'; job.message = error instanceof AuthorizationError ? error.message : '授权失败，请重新生成二维码'; }
      job.image = null;
    } finally {
      if (job.status !== 'confirmed' && job.session) {
        await this.call(`/wx/qrcodeauth/${job.session}/cancel`, 'POST', AbortSignal.timeout(5000)).catch(() => {});
      }
    }
  }
  status(id) {
    const device = this.device(id);
    if (!device) return null;
    const ref = device.accounts.at(-1) || null;
    return { authorized: !!ref, ref, status: this.jobs.get(id)?.status || (ref ? 'confirmed' : 'unconfigured') };
  }
  views() {
    return [...this.jobs.values()].filter(job => this.device(job.id))
      .map(job => ({ device: job.id.slice(-6), status: job.status, image: job.image, message: job.message }));
  }
  close() { for (const id of this.jobs.keys()) this.cancel(id); }
}
