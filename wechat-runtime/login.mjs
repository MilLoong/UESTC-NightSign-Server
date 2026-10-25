import { open } from 'node:fs/promises';
import { getLoginCode, APP_ID } from './cdp.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--code-file')) {
    throw new Error('USAGE');
  }
  const code = await getLoginCode();
  if (args.length) {
    const file = await open(args[1], 'wx', 0o600);
    try { await file.writeFile(code, 'ascii'); } finally { await file.close(); }
  }
  console.log(JSON.stringify({ ok: true, appId: APP_ID, codeLength: code.length,
                              codeSaved: args.length > 0 }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.code || 'LOGIN_FAILED' }));
  process.exitCode = 1;
}
