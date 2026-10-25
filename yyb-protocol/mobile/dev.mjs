import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createMobileServer } from './server.mjs';
import { PairingStore } from './pairing.mjs';
import { createAdminServer } from './admin.mjs';

const envFile = new URL('.env', import.meta.url);
if (!process.env.YYB_APP_TOKEN || !process.env.YYB_CORE_TOKEN) {
  try { readFileSync(envFile); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    writeFileSync(envFile, `YYB_APP_TOKEN=${randomBytes(32).toString('base64url')}\nYYB_CORE_TOKEN=${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
  }
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
const pairing = new PairingStore(process.env.YYB_STATE_DIR || fileURLToPath(new URL('.local/', import.meta.url)));
const gateway = createMobileServer({ appToken: process.env.YYB_APP_TOKEN, coreToken: process.env.YYB_CORE_TOKEN,
  coreUrl: process.env.YYB_CORE_URL || 'http://127.0.0.1:18766', pairing });
let origin = process.env.YYB_PUBLIC_ORIGIN || '';
if (origin) pairing.offer(origin);
const admin = createAdminServer(pairing, () => origin);
const children = [];
let closing = false;
function stop(exitCode = 0) {
  if (closing) return;
  closing = true;
  process.exitCode = exitCode;
  for (const child of children) child.kill();
  gateway.closeAllConnections(); gateway.close();
  admin.closeAllConnections(); admin.close();
  setTimeout(() => process.exit(exitCode), 1500).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
try {
  const executableIndex = process.argv.indexOf('--core-executable');
  if (executableIndex >= 0) {
    const executable = process.argv[executableIndex + 1];
    if (!executable) throw new Error('Missing --core-executable path');
    const child = spawn(executable, ['-host', '127.0.0.1', '-port', '18766', '-resource-root',
      fileURLToPath(new URL('.local/core/', import.meta.url))], { windowsHide: true, stdio: 'ignore',
      env: { ...process.env, YYB_AUTH_DRIVER: 'none', YYB_PROTOCOL_TOKEN: process.env.YYB_CORE_TOKEN, YYB_ENABLE_PC_LOGIN: 'false' } });
    children.push(child);
    child.on('error', () => { console.error('Protocol core failed to start'); stop(1); });
    child.on('exit', () => { if (!closing) { console.error('Protocol core exited'); stop(1); } });
  }
  gateway.listen(Number(process.env.PORT || 18767), process.env.HOST || '127.0.0.1');
  await once(gateway, 'listening');
  admin.listen(Number(process.env.ADMIN_PORT || 18768), process.env.ADMIN_HOST || '127.0.0.1');
  await once(admin, 'listening');
  console.log(`Management page: http://127.0.0.1:${admin.address().port}/dev/pair`);
  if (process.argv.includes('--public')) {
    const child = spawn(process.env.CLOUDFLARED || 'cloudflared', ['tunnel', '--no-autoupdate', '--url',
      `http://127.0.0.1:${gateway.address().port}`, '--protocol', 'http2'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let buffer = '';
    let candidate = '', connected = false;
    const consume = chunk => {
      buffer = (buffer + chunk).slice(-8192);
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s"<>|]|$)/);
      if (match) candidate = match[0];
      if (buffer.includes('Registered tunnel connection')) connected = true;
      if (candidate && connected && origin !== candidate) { origin = candidate; console.log(`Public HTTPS: ${origin}`); }
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', () => { origin = ''; console.error('Cannot start cloudflared; install it or configure YYB_PUBLIC_ORIGIN'); });
    child.on('exit', () => { origin = ''; if (!closing) console.error('HTTPS tunnel exited; restart --public to reconnect'); });
  } else if (!origin) console.log('Set YYB_PUBLIC_ORIGIN to your HTTPS origin, or start with --public.');
} catch (error) { console.error(error.code || error.message); stop(1); process.exitCode = 1; }
