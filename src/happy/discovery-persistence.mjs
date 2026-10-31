import { mkdir, open, rename, unlink, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** @param {string} path @param {unknown} value */
export async function writeDurablePrivateJson(path, value) {
  const directory = dirname(path); await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close();
    await rename(temporary, path);
    const folder = await open(directory, 'r'); try { await folder.sync(); } finally { await folder.close(); }
  } catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
}

/** @param {string} path @returns {Promise<Record<string,any>|null>} */
export async function readOptionalPrivateJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null; throw error; }
}
