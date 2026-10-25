import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = new URL('./.local/', import.meta.url);
const origin = 'http://127.0.0.1:18766';
const command = process.argv[2];
try {
  const env = await readFile(new URL('yyb.env', base), 'utf8');
  const token = env.match(/^YYB_PROTOCOL_TOKEN=([A-Za-z0-9_-]{43,128})$/m)?.[1];
  if (!token) throw new Error('TOKEN_MISSING');
  const call = async (path, method = 'GET') => {
    const response = await fetch(origin + path, { method, redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`YYB_HTTP_${response.status}`);
    const envelope = await response.json();
    if (envelope.code !== 0) throw new Error('YYB_API_ERROR');
    return envelope.data;
  };
  if (command === 'create') {
    const result = await call('/wx/qrcodeauth?as_base64=true', 'POST');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(result.session_id || '')) throw new Error('QR_ID_INVALID');
    const image = result.image_base64?.match(/^data:image\/(?:jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/);
    if (!image) throw new Error('QR_IMAGE_INVALID');
    await mkdir(base, { recursive: true, mode: 0o700 });
    await writeFile(new URL('qr-session.json', base), JSON.stringify({ session_id: result.session_id }), { mode: 0o600 });
    await writeFile(new URL('login-qr.jpg', base), Buffer.from(image[1], 'base64'), { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, stage: 'scan_required', image: fileURLToPath(new URL('login-qr.jpg', base)) }));
  } else if (command === 'poll' || command === 'confirm') {
    const { session_id: id } = JSON.parse(await readFile(new URL('qr-session.json', base), 'utf8'));
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id || '')) throw new Error('QR_ID_INVALID');
    const result = await call(`/wx/qrcodeauth/${id}/${command}`, command === 'confirm' ? 'POST' : 'GET');
    if (command === 'confirm') {
      if (!Number.isInteger(result.id) || result.id <= 0) throw new Error('ACCOUNT_ID_INVALID');
      await writeFile(new URL('account.json', base), JSON.stringify({ id: result.id }), { mode: 0o600 });
      console.log(JSON.stringify({ ok: true, stage: 'account_saved' }));
    } else console.log(JSON.stringify({ ok: true, status: result.status }));
  } else throw new Error('USE_CREATE_POLL_OR_CONFIRM');
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'QR_OPERATION_FAILED' }));
  process.exitCode = 1;
}
