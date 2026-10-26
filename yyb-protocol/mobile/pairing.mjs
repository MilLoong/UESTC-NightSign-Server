import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const secret = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');

export class PairingStore {
  constructor(directory, now = () => Date.now()) {
    this.now = now;
    this.pairs = new Map();
    this.devices = [];
    this.serverId = secret();
    if (directory) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.file = join(directory, 'devices.json');
      try { this.devices = JSON.parse(readFileSync(this.file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!Array.isArray(this.devices)) throw new Error('INVALID_DEVICE_STATE');
      const identityFile = join(directory, 'server-id');
      try { this.serverId = readFileSync(identityFile, 'utf8').trim(); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { writeFileSync(identityFile, this.serverId, { mode: 0o600, flag: 'wx' }); }
        catch (writeError) {
          if (writeError.code !== 'EEXIST') throw writeError;
          this.serverId = readFileSync(identityFile, 'utf8').trim();
        }
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(this.serverId)) throw new Error('INVALID_SERVER_IDENTITY');
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
    return { kind: 'uestc-nightsign-pair', version: 1, server: url.origin, server_id: this.serverId, code };
  }
  claim(code, { installationKey, previousProof } = {}) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
    const hash = digest(code), expires = this.pairs.get(hash);
    if (!expires || expires <= this.now()) { this.pairs.delete(hash); return null; }
    if (installationKey !== undefined && (typeof installationKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(installationKey))) return null;
    if (previousProof !== undefined && (typeof previousProof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(previousProof))) return null;
    const installationHash = installationKey ? digest(installationKey) : null;
    const existing = installationHash ? this.devices.find(item => item.installation_hash === installationHash) : null;
    // The proof binds the previous credential to this one-time code and installation key.
    // It migrates legacy records across tunnel URL changes without revealing a bearer token.
    const previous = installationKey && previousProof ? this.devices.find(item => {
      if (item.revoked) return false;
      const expected = createHmac('sha256', Buffer.from(item.hash, 'hex'))
        .update(`uestc-nightsign-rebind\n${code}\n${installationKey}`).digest('base64url');
      return timingSafeEqual(Buffer.from(expected), Buffer.from(previousProof));
    }) : null;
    const token = secret(), backup = this.devices.map(item => ({ ...item, accounts: [...item.accounts] }));
    let device = existing || previous;
    const merged = [];
    if (!device) {
      device = { id: randomBytes(12).toString('hex'), accounts: [], created: this.now() };
      this.devices.push(device);
    } else if (device.revoked) device.accounts = [];
    if (previous && previous !== device) {
      device.accounts = [...new Set([...device.accounts, ...previous.accounts])];
      previous.revoked = true; previous.accounts = []; merged.push(previous.id);
    }
    device.hash = digest(token); device.revoked = false; device.last_bound = this.now();
    if (installationHash) device.installation_hash = installationHash;
    try { this.save(); } catch (error) {
      backup.forEach((item, index) => {
        for (const key of Object.keys(this.devices[index])) delete this.devices[index][key];
        Object.assign(this.devices[index], item);
      });
      this.devices.length = backup.length;
      throw error;
    }
    this.pairs.delete(hash);
    return { token, device_id: device.id, merged_device_ids: merged, ref: device.accounts.at(-1) || null };
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
  list() { return [...this.devices].sort((a, b) => (a.last_bound || a.created) - (b.last_bound || b.created))
    .map(({ id, created, revoked }) => ({ id, created, revoked })); }
}
