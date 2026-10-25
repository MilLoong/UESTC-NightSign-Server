import { readFile, open, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { getYybCode } from './client.mjs';
import { runCheckin, schoolClient, fileLedger } from '../wechat-runtime/checkin.mjs';

let lock, lockPath;
try {
  const [configPath, mode = '--verify', ...extra] = process.argv.slice(2);
  if (!configPath || extra.length || !['--verify', '--submit'].includes(mode)) throw new Error('INVALID_ARGUMENTS');
  const path = resolve(configPath);
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (!/^[A-Za-z0-9._~-]{10,512}$/.test(config.session || '')) throw new Error('SCHOOL_SESSION_REQUIRED');
  lockPath = join(dirname(path), 'checkin.lock');
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('JOB_ALREADY_RUNNING_OR_STALE_LOCK'); throw error; }
  const result = await runCheckin({ config: config.location, request: schoolClient(config.session),
    login: () => getYybCode(config.settings), ledger: await fileLedger(join(dirname(path), 'attempts.json')),
    submit: mode === '--submit' });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  const code = error.code || error.message;
  console.error(JSON.stringify({ ok: false, error: /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'JOB_FAILED' }));
  process.exitCode = 1;
} finally {
  if (lock) { await lock.close(); await unlink(lockPath); }
}
