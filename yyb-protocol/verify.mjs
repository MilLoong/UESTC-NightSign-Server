import { readFile } from 'node:fs/promises';
import { verifyTicket, YybError } from './client.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new YybError('USAGE_PRIVATE_CONFIG_PATH_REQUIRED');
  const config = JSON.parse(await readFile(args[0], 'utf8'));
  console.log(JSON.stringify(await verifyTicket(config)));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof YybError ? error.code : 'VERIFICATION_FAILED' }));
  process.exitCode = 1;
}
