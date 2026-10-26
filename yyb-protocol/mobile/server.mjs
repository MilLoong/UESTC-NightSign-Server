import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PairingStore } from './pairing.mjs';
import { WechatAuthorization, AuthorizationError } from './authorization.mjs';

const appId = 'wxaa78bf2905f01cee';
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;

async function readLimited(stream, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('BODY_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// One private owner per deployment; appToken grants access to that owner's protocol accounts.
export function createMobileServer({ appToken, coreToken, coreUrl, fetcher = fetch, pairing = new PairingStore() }) {
  for (const token of [appToken, coreToken]) {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token || '')) throw new Error('INVALID_TOKEN');
  }
  const upstream = new URL(coreUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password ||
      upstream.search || upstream.hash || upstream.pathname !== '/') throw new Error('INVALID_CORE_URL');
  let active = 0;
  const authorization = new WechatAuthorization(pairing, async (path, method, signal) => {
    const response = await fetcher(new URL(path, upstream), { method, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]),
      headers: { Authorization: `Bearer ${coreToken}`, 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined });
    let envelope;
    try { envelope = JSON.parse(await readLimited(response.body, 1_048_576)); }
    catch { throw new AuthorizationError('协议核心响应无效'); }
    if (!response.ok || envelope.code !== 0) {
      const message = /lookup |no such host|server misbehaving/i.test(String(envelope.msg || ''))
        ? '协议核心 DNS 解析失败' : `协议核心请求失败（HTTP ${response.status}）`;
      throw new AuthorizationError(message, [408, 409, 429].includes(response.status) || response.status >= 500);
    }
    return envelope.data;
  });
  let pairWindow = 0, pairRequests = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status, data, msg = 'success') => {
      if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ code: status === 200 ? 0 : status, msg, data }));
    };
    if (req.headers.origin) { req.resume(); reply(401, null, 'UNAUTHORIZED'); return; }
    if (req.url === '/v1/pair' && req.method === 'POST') {
      if (Date.now() - pairWindow > 60_000) { pairWindow = Date.now(); pairRequests = 0; }
      if (++pairRequests > 30) { req.resume(); reply(429, null, 'PAIR_RATE_LIMIT'); return; }
      try {
        const body = JSON.parse((await readLimited(req, 4096)).toString());
        const device = pairing.claim(body.code, { installationKey: body.installation_key, previousProof: body.previous_proof });
        if (device) {
          authorization.reset(device.device_id);
          for (const id of device.merged_device_ids) authorization.reset(id);
        }
        reply(device ? 200 : 400, device, device ? 'success' : 'PAIR_EXPIRED_OR_USED');
      } catch { reply(400, null, 'INVALID_PAIR_REQUEST'); }
      return;
    }
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const device = pairing.authenticate(bearer);
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${appToken}`);
    const administrator = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!device && !administrator) {
      req.resume(); reply(401, null, 'UNAUTHORIZED'); return;
    }
    if (req.url === '/v1/device' && req.method === 'DELETE') {
      req.resume();
      if (!device) { reply(403, null, 'DEVICE_TOKEN_REQUIRED'); return; }
      try { pairing.revoke(device.id); authorization.cancel(device.id); reply(200, { revoked: true }); }
      catch { reply(500, null, 'STATE_SAVE_FAILED'); }
      return;
    }
    if (req.url === '/v1/device' && req.method === 'GET') {
      req.resume();
      if (!device) { reply(403, null, 'DEVICE_TOKEN_REQUIRED'); return; }
      reply(200, authorization.status(device.id)); return;
    }
    if (active >= 8) { req.resume(); reply(429, null, 'TOO_MANY_REQUESTS'); return; }
    active++;
    const abort = new AbortController();
    const onClose = () => abort.abort();
    res.on('close', onClose);
    const timer = setTimeout(() => abort.abort(), 65_000);
    try {
      const url = new URL(req.url, 'http://localhost');
      const session = url.pathname.match(/^\/wx\/qrcodeauth\/([A-Za-z0-9_-]{1,128})\/(poll|confirm|cancel)$/);
      let payload;
      let kind;
      if (url.pathname === '/health' && !url.search && req.method === 'GET') kind = 'health';
      else if (url.pathname === '/wx/qrcodeauth' && url.search === '?as_base64=true' && req.method === 'POST') kind = 'create';
      else if (session && !url.search && req.method === (session[2] === 'poll' ? 'GET' : 'POST')) kind = session[2];
      else if (url.pathname === '/wxapp/getCode' && !url.search && req.method === 'POST') kind = 'code';
      else { req.resume(); reply(404, null, 'NOT_FOUND'); return; }
      if (!administrator && !['health', 'code'].includes(kind)) {
        req.resume(); reply(404, null, 'SERVER_MANAGED_AUTHORIZATION'); return;
      }
      if (req.method === 'POST') {
        let input;
        try { input = JSON.parse((await readLimited(req, 4096)).toString() || '{}'); }
        catch { reply(400, null, 'INVALID_BODY'); return; }
        if (kind === 'code') {
          if (input?.app_id !== appId || typeof input.ref !== 'string' || !idPattern.test(input.ref)) {
            reply(400, null, 'INVALID_APP_OR_ACCOUNT'); return;
          }
          if (!administrator && !device.accounts.includes(input.ref)) { reply(403, null, 'ACCOUNT_NOT_OWNED'); return; }
          payload = JSON.stringify({ app_id: appId, ref: input.ref });
        } else payload = '{}';
      }
      const response = await fetcher(new URL(url.pathname + url.search, upstream), {
        method: req.method, redirect: 'error', signal: abort.signal,
        headers: { Authorization: `Bearer ${coreToken}`, 'Content-Type': 'application/json' }, body: payload,
      });
      const bytes = await readLimited(response.body, 1_048_576);
      let envelope;
      try { envelope = JSON.parse(bytes); } catch { reply(502, null, 'INVALID_CORE_RESPONSE'); return; }
      if (!response.ok || envelope.code !== 0) {
        // Raw upstream errors may contain QR UUIDs, OAuth codes or login-buffer URLs.
        const detail = String(envelope.msg || '');
        const msg = /lookup |no such host|server misbehaving/i.test(detail) ? 'DNS lookup failed' : 'YYB_CORE_REQUEST_FAILED';
        reply(response.ok ? 502 : response.status, null, msg); return;
      }
      const data = envelope.data;
      if (device && device.revoked) { reply(401, null, 'DEVICE_REVOKED'); return; }
      let output;
      switch (kind) {
        case 'health': output = { ok: data?.ok === true }; break;
        case 'create':
          if (!idPattern.test(data?.session_id || '') || !/^data:image\/(jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$/.test(data?.image_base64 || '')) throw new Error('INVALID_QR');
          output = { session_id: data.session_id, image_base64: data.image_base64, status: data.status }; break;
        case 'poll': case 'cancel':
          output = { status: data?.status }; break;
        case 'confirm':
          if (!Number.isSafeInteger(data?.id) || data.id <= 0) throw new Error('INVALID_ACCOUNT');
          output = { id: data.id }; break;
        case 'code': output = { result: { code: data?.result?.code } }; break;
      }
      reply(200, output);
    } catch { reply(502, null, 'CORE_CONNECTION_FAILED'); }
    finally { clearTimeout(timer); res.off('close', onClose); active--; }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.pairing = pairing;
  server.authorization = authorization;
  server.authorizationViews = () => authorization.views();
  server.on('close', () => authorization.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createMobileServer({ appToken: process.env.YYB_APP_TOKEN,
    coreToken: process.env.YYB_CORE_TOKEN, coreUrl: process.env.YYB_CORE_URL || 'http://127.0.0.1:18766',
    pairing: new PairingStore(process.env.YYB_STATE_DIR || fileURLToPath(new URL('./.local/', import.meta.url))) });
  server.listen(Number(process.env.PORT || 18767), process.env.HOST || '127.0.0.1', () => console.log('YYB mobile gateway ready'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.close(); setTimeout(() => process.exit(0), 5000).unref();
  });
}
