import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile), script = fileURLToPath(new URL('../scripts/codelight-daemon.mjs', import.meta.url));

test('CLI rejects non-Codex and empty only scopes before profile creation or pairing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-cli-scope-')), profile = join(directory, 'not-created');
  try {
    for (const only of ['zcode:window-id', 'claude-desktop:window-id', 'codex:', 'Codex:case-sensitive', 'codex: padded-id ']) {
      await assert.rejects(run(process.execPath, [script, '--server=http://127.0.0.1:1', `--profile=${profile}`, `--only=${only}`, '--account-file=/fixture-do-not-read.json']),
        error => /** @type {Record<string,any>} */ (error).stderr.includes('Only native Codex session scope is supported'));
      await assert.rejects(stat(profile), { code: 'ENOENT' });
    }
    await assert.rejects(run(process.execPath, [script, '--help', '--only=terminal:window']),
      error => /** @type {Record<string,any>} */ (error).stderr.includes('Only native Codex session scope is supported'));
    const help = await run(process.execPath, [script, '--help', '--only=codex:fixture-native-id']);
    assert.match(help.stdout, /CodeLight Mac:/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
