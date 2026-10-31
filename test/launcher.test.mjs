import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

test('one-command launcher reuses its verified service, rotates pairing only, and cleans its own receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-launcher-'));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve) => reservation.close(() => resolve(undefined)));
  const launcher = fileURLToPath(new URL('../scripts/launch.mjs', import.meta.url));
  const args = [launcher, `--port=${port}`];
  const env = { ...process.env, BRIDGE_DATA_DIR: directory };
  const first = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // 启动失败时 exit 可能先于轮询结束；提前等待并保留 stderr，避免 finally 丢失原始失败。
  const firstExit = new Promise((resolve) => first.once('exit', resolve));
  let firstError = ''; first.stdout.resume(); first.stderr.on('data', (data) => { firstError += data.toString(); });
  try {
    let runtime;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { runtime = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.ok(runtime, firstError || 'launcher did not write its runtime receipt');
    assert.equal(runtime.pid, first.pid);
    assert.equal((await stat(join(directory, 'runtime.json'))).mode & 0o777, 0o600);
    const duplicate = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; duplicate.stdout.on('data', (data) => { output += data.toString(); }); duplicate.stderr.resume();
    assert.equal(await new Promise((resolve) => duplicate.on('exit', resolve)), 0);
    assert.ok(output.includes('独立服务已在运行'));
    const after = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
    assert.equal(after.pid, first.pid); assert.equal(after.instanceId, runtime.instanceId);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json());
    assert.equal(health.instanceId, runtime.instanceId);
  } finally {
    if (first.exitCode === null && first.signalCode === null) first.kill('SIGTERM');
    await firstExit;
    await assert.rejects(readFile(join(directory, 'runtime.json')));
    await rm(directory, { recursive: true, force: true });
  }
});
