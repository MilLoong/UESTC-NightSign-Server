import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function createAdminServer(pairing, getOrigin) {
  const csrf = randomBytes(32).toString('base64url');
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    const host = req.headers.host;
    if (host !== `127.0.0.1:${server.address().port}` && host !== `localhost:${server.address().port}`) {
      req.resume(); res.writeHead(403).end(); return;
    }
    if (req.url === '/dev/revoke' && req.method === 'POST') {
      let body = '', tooLarge = false;
      try {
        for await (const chunk of req) { body += chunk; if (body.length > 4096) { tooLarge = true; break; } }
      } catch { if (!res.destroyed) res.writeHead(400).end(); return; }
      const form = new URLSearchParams(body), value = Buffer.from(form.get('csrf') || '');
      if (tooLarge || value.length !== csrf.length || !timingSafeEqual(value, Buffer.from(csrf))) {
        res.writeHead(403).end(); return;
      }
      try { pairing.revoke(form.get('device')); res.writeHead(303, { Location: '/dev/pair' }).end(); }
      catch { res.writeHead(500).end('State save failed'); }
      return;
    }
    if (req.method !== 'GET' || req.url !== '/dev/pair') { req.resume(); res.writeHead(404).end(); return; }
    try {
      const origin = getOrigin();
      if (!origin) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end('<meta charset="utf-8"><meta http-equiv="refresh" content="3"><p>正在等待 HTTPS 隧道地址，请稍候或检查服务终端</p>');
        return;
      }
      const offer = pairing.offer(origin);
      const image = await QRCode.toString(JSON.stringify(offer), { type: 'svg', margin: 2 });
      const devices = pairing.list().filter(item => !item.revoked).map(item =>
        `<form method="post" action="/dev/revoke"><input type="hidden" name="csrf" value="${csrf}">` +
        `<input type="hidden" name="device" value="${escape(item.id)}">设备 ${escape(item.id.slice(-6))} <button>撤销绑定</button></form>`).join('');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>晚安成电服务器绑定</title>
<style>body{font:17px system-ui;max-width:600px;margin:40px auto;padding:16px}svg{width:320px;max-width:100%;height:auto}code{overflow-wrap:anywhere}form{margin:12px 0}</style>
<h1>扫码连接服务器</h1><p>在 APP 的设置中点「扫码连接服务器」，确认地址后绑定</p><code>${escape(offer.server)}</code>
${image}<p>绑定码 120 秒有效，仅能使用一次，过期后刷新页面</p><p>绑定后，在 APP 内生成微信授权二维码</p>
${offer.server.endsWith('.trycloudflare.com') ? '<p>临时隧道经 Cloudflare 中转，地址变化后需重新绑定</p>' : ''}
<h2>已绑定设备</h2>${devices || '<p>暂无设备</p>'}</html>`);
    } catch { if (!res.headersSent) res.writeHead(500).end('Pairing page unavailable'); }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  return server;
}
