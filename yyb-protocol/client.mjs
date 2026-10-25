export const APP_ID = 'wxaa78bf2905f01cee';

export class YybError extends Error {
  constructor(code) { super(code); this.code = code; }
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

export async function verifyTicket({ settings, session }, fetcher = fetch) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9._~-]{10,512}$/.test(session)) throw new YybError('SCHOOL_SESSION_REQUIRED');
  const code = await getYybCode(settings, fetcher);
  const response = await fetcher('https://jzsz.uestc.edu.cn/platform-app/api/auth/checkin-ticket', {
    method: 'POST', redirect: 'error', headers: {
      Cookie: `SESSION=${session}`, 'Content-Type': 'application/json', platform: 'mp-weixin',
    }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(15000),
  });
  let body;
  try { body = await response.json(); } catch { throw new YybError('SCHOOL_RESPONSE_INVALID'); }
  const ticket = typeof body.data === 'string' ? body.data : body.data?.ticket;
  if (!response.ok || body.code !== 0 || typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
    throw new YybError(Number.isInteger(body.code) ? `SCHOOL_${body.code}` : 'SCHOOL_AUTH_FAILED');
  }
  return { ok: true, appId: APP_ID, codeLength: code.length, ticketLength: ticket.length, checkinSubmitted: false };
}
