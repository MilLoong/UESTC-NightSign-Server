export const APP_ID = 'wxaa78bf2905f01cee';

const SCHOOL_SESSION = /^[A-Za-z0-9._~-]{10,512}$/;
const SESSION_REJECTED = new Set(['SCHOOL_401', 'SCHOOL_4001', 'SCHOOL_HTTP_401']);
const CHECK_BIND = 'https://jzsz.uestc.edu.cn/platform-app/api/auth/check-bind';
const CHECKIN_TICKET = 'https://jzsz.uestc.edu.cn/platform-app/api/auth/checkin-ticket';

export class YybError extends Error {
  constructor(code, detail = '') { super(code); this.code = code; this.detail = detail; }
}

export function validateSettings(settings) {
  let url;
  try { url = new URL(settings.endpoint); } catch { throw new YybError('YYB_URL_INVALID'); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new YybError('YYB_HTTPS_REQUIRED');
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(settings.token || '')) throw new YybError('YYB_TOKEN_INVALID');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(settings.ref || ''))) throw new YybError('YYB_ACCOUNT_REQUIRED');
  return new URL('wxapp/getCode', url.href.replace(/\/?$/, '/'));
}

export async function getYybCode(settings, fetcher = fetch) {
  const url = validateSettings(settings);
  let response;
  try {
    response = await fetcher(url, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: String(settings.ref), app_id: APP_ID }), signal: AbortSignal.timeout(60000) });
  } catch { throw new YybError('YYB_CONNECTION_FAILED'); }
  if (!response.ok) throw new YybError(`YYB_HTTP_${response.status}`);
  let raw = '';
  try {
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4096) { await reader.cancel(); throw new YybError('YYB_RESPONSE_TOO_LARGE'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      raw = new TextDecoder().decode(bytes);
    } finally { reader.releaseLock(); }
  } catch (error) {
    if (error instanceof YybError) throw error;
    throw new YybError('YYB_RESPONSE_INVALID');
  }
  let result;
  try { result = JSON.parse(raw); } catch { throw new YybError('YYB_RESPONSE_INVALID'); }
  if ('data' in result) {
    if (result.code !== 0) throw new YybError('YYB_API_ERROR');
    result = result.data;
  }
  const code = result?.result?.code;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(code)) throw new YybError('YYB_CODE_INVALID');
  return code;
}

async function schoolPost(url, session, body, fetcher) {
  let response;
  try {
    const headers = { 'Content-Type': 'application/json', platform: 'mp-weixin' };
    if (session) headers.Cookie = `SESSION=${session}`;
    response = await fetcher(url, { method: 'POST', redirect: 'error', headers,
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch { throw new YybError('SCHOOL_CONNECTION_FAILED'); }
  if (response.status === 401) throw new YybError('SCHOOL_401');
  let result;
  try { result = await response.json(); } catch { throw new YybError('SCHOOL_RESPONSE_INVALID'); }
  return { response, result };
}

/** Obtain a school session from a fresh wx.login code (no CAS involved). */
export async function acquireSession(settings, fetcher = fetch) {
  const code = await getYybCode(settings, fetcher);
  const { response, result } = await schoolPost(CHECK_BIND, null, { code, sn: '' }, fetcher);
  if (!response.ok) throw new YybError(`SCHOOL_HTTP_${response.status}`);
  if (result?.code !== 0 || result?.ok === false) {
    throw new YybError(Number.isInteger(result?.code) ? `SCHOOL_${result.code}` : 'SCHOOL_AUTH_FAILED');
  }
  const data = result?.data;
  if (!data || data.bind !== true) throw new YybError('WECHAT_NOT_BOUND');
  if (typeof data.sessionId !== 'string' || !SCHOOL_SESSION.test(data.sessionId)) throw new YybError('SCHOOL_SESSION_INVALID');
  return data.sessionId;
}

async function exchangeTicket(session, settings, fetcher) {
  const code = await getYybCode(settings, fetcher);
  const { response, result } = await schoolPost(CHECKIN_TICKET, session, { code }, fetcher);
  const ticket = typeof result?.data === 'string' ? result.data : result?.data?.ticket;
  if (!response.ok || result?.code !== 0 || typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
    throw new YybError(Number.isInteger(result?.code) ? `SCHOOL_${result.code}` : `SCHOOL_HTTP_${response.status}`);
  }
  return { ok: true, appId: APP_ID, codeLength: code.length, ticketLength: ticket.length, checkinSubmitted: false };
}

/**
 * Verify ticket acquisition. Without a configured session it acquires one via
 * check-bind; a rejected session is rebuilt once and the exchange retried.
 */
export async function verifyTicket({ settings, session }, fetcher = fetch) {
  let sid = SCHOOL_SESSION.test(session || '') ? session : null;
  let refreshed = false;
  for (;;) {
    if (!sid) sid = await acquireSession(settings, fetcher);
    try {
      return await exchangeTicket(sid, settings, fetcher);
    } catch (error) {
      if (refreshed || !(error instanceof YybError) || !SESSION_REJECTED.has(error.code)) throw error;
      refreshed = true;
      sid = null;
    }
  }
}
