import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const secret = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');

export class PairingStore {
  constructor(directory, now = () => Date.now()) {
    this.now = now;
    this.pairs = new Map();
    this.devices = [];
    if (directory) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.file = join(directory, 'devices.json');
      try { this.devices = JSON.parse(readFileSync(this.file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!Array.isArray(this.devices)) throw new Error('INVALID_DEVICE_STATE');
    }
  }
  save() {
    if (!this.file) return;
    const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.devices), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.file);
  }
  offer(server) {
    const url = new URL(server);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('HTTPS_ORIGIN_REQUIRED');
    }
    const code = secret();
    // Other tabs and health checks must not invalidate a QR the user is already scanning.
    for (const [hash, expires] of this.pairs) if (expires <= this.now()) this.pairs.delete(hash);
    while (this.pairs.size >= 32) this.pairs.delete(this.pairs.keys().next().value);
    this.pairs.set(digest(code), this.now() + 120_000);
    return { kind: 'uestc-nightsign-pair', version: 1, server: url.origin, code };
  }
  claim(code) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
    const hash = digest(code), expires = this.pairs.get(hash);
    if (!expires || expires <= this.now()) { this.pairs.delete(hash); return null; }
    const token = secret(), id = randomBytes(12).toString('hex');
    const device = { id, hash: digest(token), accounts: [], revoked: false, created: this.now() };
    this.devices.push(device);
    try { this.save(); } catch (error) { this.devices.pop(); throw error; }
    this.pairs.delete(hash);
    return { token, device_id: id };
  }
  authenticate(token) {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token || '')) return null;
    return this.devices.find(device => !device.revoked && device.hash === digest(token)) || null;
  }
  grant(deviceId, account) {
    const device = this.devices.find(item => item.id === deviceId && !item.revoked);
    if (!device) throw new Error('DEVICE_REVOKED');
    const ref = String(account);
    const previous = this.devices.map(item => [...item.accounts]);
    // A fresh WeChat confirmation proves consent to move this account to the new binding.
    for (const item of this.devices) if (item.id !== deviceId) item.accounts = item.accounts.filter(value => value !== ref);
    if (!device.accounts.includes(ref)) device.accounts.push(ref);
    try { this.save(); } catch (error) {
      this.devices.forEach((item, index) => { item.accounts = previous[index]; });
      throw error;
    }
  }
  revoke(id) {
    const device = this.devices.find(item => item.id === id);
    if (device) {
      const old = device.revoked;
      device.revoked = true;
      try { this.save(); } catch (error) { device.revoked = old; throw error; }
    }
  }
  list() { return this.devices.map(({ id, created, revoked }) => ({ id, created, revoked })); }
}
