import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicAccessManager, EntryProbes } from '../src/network/public-access.mjs';

/** @typedef {Record<string,any>} Value */
class Transport extends EventEmitter {
  /** @param {Value} config */ constructor(config) { super(); this.config = config; this.closed = false; this.paused = false; }
  async start() { if (this.config.mode === 'relay' && !this.config.token) throw Error('access-key-required'); return this.config.mode === 'cloudflare' ? 'https://direct.example' : this.config.serverUrl + '/r/' + 'a'.repeat(24); }
  activate() {}
  /** @param {boolean} value */ pauseReconnect(value) { this.paused = value; }
  close() { this.closed = true; }
}
test('failed validation preserves the working entry and saved credentials never cross server addresses', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-access-'));
  const transports = /** @type {Transport[]} */ ([]), probes = new EntryProbes();
  probes.verify = async origin => { if (origin.includes('wrong.example')) throw Error('bad-public-probe'); };
  const manager = new PublicAccessManager({ state: directory, upstream: 'http://127.0.0.1:1', cloudflared: 'unused', probes,
    transportFactory: config => { const transport = new Transport(config); transports.push(transport); return transport; } });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  await manager.load(); const first = transports[0];
  await assert.rejects(() => manager.apply({ mode: 'relay', serverUrl: 'https://wrong.example', token: 'a'.repeat(43) }));
  assert.equal(first.closed, false); assert.equal(first.paused, false); assert.equal(manager.summary().mode, 'cloudflare');
  await manager.apply({ mode: 'relay', serverUrl: 'https://good.example', token: 'a'.repeat(43) });
  const saved = JSON.parse(await readFile(join(directory, 'network-access.json'), 'utf8'));
  assert.equal((await stat(join(directory, 'network-access.json'))).mode & 0o777, 0o600);
  await assert.rejects(() => manager.apply({ mode: 'relay', serverUrl: 'https://another.example' }));
  assert.equal(transports.at(-1)?.config.token, '');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'network-access.json'), 'utf8')), saved);
  assert.ok(!JSON.stringify(manager.summary()).includes('a'.repeat(43)));
  assert.equal(first.closed, true);
});
