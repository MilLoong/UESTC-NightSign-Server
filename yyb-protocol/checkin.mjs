import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { getYybCode } from './client.mjs';
import { runCheckin, schoolClient, fileLedger } from '../wechat-runtime/checkin.mjs';

const SCHOOL_SESSION = /^[A-Za-z0-9._~-]{10,512}$/;
let lock, lockPath;

// Best effort: the refreshed session stays in memory when the config is read-only.
async function writeConfig(path, config) {
  try {
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } catch { /* ignore */ }
}

try {
  const [configPath, mode = '--verify', ...extra] = process.argv.slice(2);
  if (!configPath || extra.length || !['--verify', '--submit'].includes(mode)) throw new Error('INVALID_ARGUMENTS');
  const path = resolve(configPath);
  const config = JSON.parse(await readFile(path, 'utf8'));
  lockPath = join(dirname(path), 'checkin.lock');
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('JOB_ALREADY_RUNNING_OR_STALE_LOCK'); throw error; }
  const login = () => getYybCode(config.settings);
  const request = schoolClient({
    sid: SCHOOL_SESSION.test(config.session || '') ? config.session : null,
    login,
    rememberSessionId: async session => {
      config.session = session;
      await writeConfig(path, config);
    },
  });
  const result = await runCheckin({ config: config.location, request, login,
    ledger: await fileLedger(join(dirname(path), 'attempts.json')), submit: mode === '--submit' });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  const code = error.code || error.message;
  console.error(JSON.stringify({ ok: false, error: /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'JOB_FAILED' }));
  process.exitCode = 1;
} finally {
  if (lock) { await lock.close(); await unlink(lockPath); }
}
