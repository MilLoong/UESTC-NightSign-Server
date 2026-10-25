import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { CdpSession, APP_ID, CODE_PATTERN } from './cdp.mjs';

const ORIGIN = 'https://jzsz.uestc.edu.cn';
const PREFIX = '/daily-checkin/api/';
export class JobError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireValue = (value, code) => { if (!value) throw new JobError(code); };

export function chinaClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    timestamp: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` };
}

export function distanceMeters(a, b) {
  const rad = value => value * Math.PI / 180;
  const dlat = rad(b.latitude - a.latitude), dlng = rad(b.longitude - a.longitude);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dlng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function validateConfig(config) {
  requireValue(config.coordinateSystemCode === 'gcj02', 'COORDINATE_SYSTEM_INVALID');
  requireValue(Number.isFinite(config.latitude) && Math.abs(config.latitude) <= 90 &&
    Number.isFinite(config.longitude) && Math.abs(config.longitude) <= 180, 'COORDINATES_INVALID');
  return config;
}

async function connectWechat(Socket) {
  const socket = new Socket('ws://127.0.0.1:62000');
  const session = new CdpSession(socket, 12000);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new JobError('CDP_CONNECT_TIMEOUT')), 12000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new JobError('CDP_UNAVAILABLE')); }, { once: true });
    });
    await session.command('Runtime.disable');
    await session.command('Runtime.enable');
    let target;
    for (const id of session.contexts) {
      const identity = await session.evaluate(id, '(() => { try { return wx.getAccountInfoSync().miniProgram.appId; } catch (_) { return null; } })()').catch(() => null);
      if (identity === APP_ID) { target = id; break; }
    }
    requireValue(target !== undefined, 'TARGET_NOT_OPEN');
    const sid = await session.evaluate(target, "wx.getStorageSync('sessionId')");
    requireValue(typeof sid === 'string' && /^[A-Za-z0-9._-]{10,256}$/.test(sid), 'SCHOOL_SESSION_MISSING');
    return { sid, close: () => session.close(), login: async () => {
      const code = await session.evaluate(target, `new Promise(resolve => {
        if (wx.getAccountInfoSync().miniProgram.appId !== '${APP_ID}') { resolve(null); return; }
        wx.login({ timeout: 10000, success: r => resolve(r.code || null), fail: () => resolve(null) });
      })`);
      requireValue(typeof code === 'string' && CODE_PATTERN.test(code), 'WX_LOGIN_FAILED');
      return code;
    } };
  } catch (error) { session.close(); throw error; }
}

function schoolClient(sid) {
  return async (path, { body, ticket, platform = 'h5' } = {}) => {
    const headers = { Cookie: `SESSION=${sid}`, platform, Accept: 'application/json',
      Origin: ORIGIN, Referer: `${ORIGIN}/daily-checkin-h5/index.html?appId=294`,
      'User-Agent': 'UESTC-NightSign-Server/1.0' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (ticket) headers['X-Checkin-Ticket'] = ticket;
    const response = await fetch(ORIGIN + path, { method: body === undefined ? 'GET' : 'POST',
      headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(15000) });
    requireValue(response.ok, `HTTP_${response.status}`);
    const text = await response.text();
    requireValue(text.length < 1024 * 1024, 'RESPONSE_TOO_LARGE');
    let result;
    try { result = JSON.parse(text); } catch { throw new JobError('RESPONSE_NOT_JSON'); }
    requireValue(result.code === 0 && result.ok !== false,
      Number.isInteger(result.code) ? `PLATFORM_${result.code}` : 'BUSINESS_RESPONSE_INVALID');
    return result.data;
  };
}

async function fileLedger(path) {
  let ledger;
  try { ledger = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; ledger = {}; }
  requireValue(ledger && typeof ledger === 'object' && !Array.isArray(ledger), 'LEDGER_INVALID');
  return { get: date => ledger[date], put: async (date, value) => {
    ledger[date] = value;
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(ledger), { mode: 0o600 });
    await rename(temporary, path);
  } };
}

export async function runCheckin({ config, request, login, ledger, submit = false, now = () => new Date() }) {
  validateConfig(config);
  const clock = chinaClock(now());
  const today = await request(PREFIX + 'student-checkin-record/today');
  requireValue(today?.businessDate === clock.date && typeof today.recordStatusCode === 'string', 'TODAY_RESPONSE_INVALID');
  if (today.recordStatusCode === 'CHECKED_IN') return { ok: true, stage: 'already_checked_in', businessDate: clock.date };
  if (submit) requireValue(!ledger.get(clock.date), 'ATTEMPT_ALREADY_RECORDED');
  const schedule = await request(PREFIX + 'checkin-schedule/effective');
  const start = schedule?.studentCheckinStartOffsetMinute, end = schedule?.studentCheckinEndOffsetMinute;
  requireValue(schedule?.effective === true && Number.isInteger(start) && Number.isInteger(end) &&
    start >= 0 && end <= 1439 && start <= end, 'SCHEDULE_INVALID');
  if (submit) requireValue(clock.minute >= start && clock.minute <= end, 'OUTSIDE_CHECKIN_WINDOW');
  const locations = await request(PREFIX + 'checkin-location/available-locations');
  requireValue(Array.isArray(locations), 'LOCATIONS_INVALID');
  const inRange = locations.some(location => Number.isFinite(location.latitude) && Number.isFinite(location.longitude) &&
    Number.isFinite(location.radiusMeter) && location.radiusMeter > 0 && distanceMeters(config, location) <= location.radiusMeter);
  requireValue(inRange, 'OUTSIDE_ALLOWED_LOCATION');
  const addressData = await request(PREFIX + `map/reverse?lat=${config.latitude}&lng=${config.longitude}`);
  const address = typeof addressData === 'string' ? addressData :
    addressData?.address || addressData?.reverseGeocode || addressData?.formattedAddress;
  requireValue(typeof address === 'string' && address.trim(), 'ADDRESS_MISSING');
  const code = await login();
  const auth = await request('/platform-app/api/auth/checkin-ticket', { body: { code }, platform: 'mp-weixin' });
  const ticket = typeof auth === 'string' ? auth : auth?.ticket;
  requireValue(typeof ticket === 'string' && /^[A-Za-z0-9_-]{43}$/.test(ticket), 'TICKET_INVALID');
  if (!submit) return { ok: true, stage: 'authorization_verified', businessDate: clock.date,
    inRange, startMinute: start, endMinute: end, codeLength: code.length, ticketLength: ticket.length, checkinSubmitted: false };
  const beforeSubmit = chinaClock(now());
  requireValue(beforeSubmit.date === clock.date && beforeSubmit.minute >= start && beforeSubmit.minute <= end, 'CHECKIN_WINDOW_CHANGED');
  // Configured coordinates have no live GPS measurement; do not invent sensor diagnostics.
  const payload = { latitude: config.latitude, longitude: config.longitude, reverseGeocode: address,
    clientTime: beforeSubmit.timestamp, userAgent: 'UESTC-NightSign-Server/1.0', coordinateSystemCode: 'gcj02',
    accuracy: 0, locationDurationMs: 0, networkTypeCode: 'unknown', locationEnabled: false,
    locationAuthorized: '', locationAccuracy: '', errorMessage: 'configured coordinate; no live positioning' };
  await ledger.put(clock.date, { stage: 'sending', time: beforeSubmit.timestamp });
  let accepted = false;
  try {
    accepted = await request(PREFIX + 'student-checkin-record/checkin', { body: payload, ticket }) === true;
  } catch {
    // A timed-out POST can still succeed. Only query; never repeat the POST automatically.
  }
  let confirmed = false;
  try {
    const after = await request(PREFIX + 'student-checkin-record/today');
    confirmed = after?.businessDate === clock.date && after.recordStatusCode === 'CHECKED_IN';
  } catch { /* Keep the attempt recorded even if verification is unavailable. */ }
  const stage = confirmed ? 'checked_in_confirmed' : accepted ? 'accepted_unconfirmed' : 'result_unknown';
  await ledger.put(clock.date, { stage, time: beforeSubmit.timestamp });
  return { ok: confirmed, stage, businessDate: clock.date, postAccepted: accepted, checkinSubmitted: true };
}

async function main() {
  let wechat;
  try {
    const args = process.argv.slice(2);
    requireValue(args.length <= 1 && (!args.length || ['--verify', '--submit'].includes(args[0])), 'INVALID_ARGUMENTS');
    const config = validateConfig(JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8')));
    const { WebSocket } = await import('ws');
    wechat = await connectWechat(WebSocket);
    const result = await runCheckin({ config, request: schoolClient(wechat.sid), login: wechat.login,
      ledger: await fileLedger(new URL('./attempts.json', import.meta.url).pathname), submit: args[0] === '--submit' });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof JobError ? error.code :
      error.code?.startsWith('CDP_') ? error.code : 'JOB_FAILED' }));
    process.exitCode = 1;
  } finally { wechat?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
