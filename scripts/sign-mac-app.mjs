import { readdir, open, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
const run = promisify(execFile);
const app = resolve(process.argv[2]);
const identity = process.argv[3];
if (!identity) throw Error('A signing identity is required');
const magic = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf']);
/** @type {string[]} */ const binaries = [];
/** @param {string} folder */
async function scan(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (entry.isFile()) {
      const file = await open(path, 'r'); const head = Buffer.alloc(4);
      try { await file.read(head, 0, 4, 0); } finally { await file.close(); }
      if (magic.has(head.toString('hex'))) binaries.push(path);
    }
  }
}
await scan(join(app, 'Contents'));
const entitlements = join(tmpdir(), 'codelight-sign-' + randomUUID() + '.plist');
await writeFile(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>', { mode: 0o600 });
try {
  for (const binary of binaries) {
    await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity,
      ...(binary === join(app, 'Contents/Resources/runtime/node') ? ['--entitlements', entitlements] : []), binary]);
  }
  await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, app]);
  await run('codesign', ['--verify', '--deep', '--strict', app]);
  for (const binary of binaries) await run('codesign', ['--verify', '--strict', binary]);
  console.log(JSON.stringify({ signedApp: app, verifiedBinaries: binaries.length, notarized: false }));
} finally { await rm(entitlements, { force: true }); }
