import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const token = () => randomBytes(32).toString('base64url');
try {
  await writeFile(new URL('.env', import.meta.url), `YYB_APP_TOKEN=${token()}\nYYB_CORE_TOKEN=${token()}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created private server configuration. Clients connect using the pairing QR.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing private server configuration preserved.');
}
