import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionChannelsManager } from '../src/network/connection-channels.mjs';
import { writeDurablePrivateJson } from '../src/happy/discovery-persistence.mjs';

/** @typedef {Record<string,any>} Value */
function deferred() { let resolve = /** @type {(value:any)=>void} */ (() => {}), reject = /** @type {(error:Error)=>void} */ (() => {}); const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
/** @param {()=>boolean} predicate */
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.ok(predicate()); }
class Transport extends EventEmitter {
  /** @param {Value} config @param {Value} [controls] */
  constructor(config, controls = {}) { super(); this.config = config; this.controls = controls; this.closed = false; this.active = false; }
  async start() { if (this.controls.start) return this.controls.start; if (this.controls.fail) throw Error('fixture-start-failed'); return this.config.kind === 'relay' ? this.config.serverUrl + '/r/' + 'a'.repeat(24) : 'https://direct.example'; }
  activate() { this.active = true; }
  pauseReconnect() {}
  close() { this.closed = true; }
}
/** @param {import('node:test').TestContext} t @param {Value} [controls] */
async function fixture(t, controls = {}) {
  const state = await mkdtemp(join(tmpdir(), 'codelight-channels-')), transports = /** @type {Transport[]} */ ([]), local = { channels: [{ id: 'lan-fixture', kind: 'local', url: 'http://192.168.50.2:8080', label: 'Local network' }], closed: false, close() { this.closed = true; } };
  const manager = new ConnectionChannelsManager({ state, cloudflared: 'unused', upstreamFor: kind => 'http://127.0.0.1:' + (kind === 'cloudflare' ? '1001' : '1002'),
    probesFor: kind => ({ verify: async (url, signal) => { if (signal?.aborted) throw Error('cancelled'); if (controls.verify) await controls.verify(kind, url); } }),
    startLocal: async signal => { if (signal.aborted) throw Error('cancelled'); return controls.localStart ? await controls.localStart : local; },
    transportFactory: config => { const transport = new Transport(config, controls.transport?.(config) ?? {}); transports.push(transport); return transport; } });
  t.after(async () => { await manager.close(); await rm(state, { recursive: true, force: true }); });
  return { state, manager, transports, local };
}

test('legacy migration defaults all available entries and a pending Cloudflare cannot block ready LAN and Relay', async t => {
  const slow = deferred(), f = await fixture(t, { transport: (/** @type {Value} */ config) => config.kind === 'cloudflare' ? { start: slow.promise } : {} });
  await writeDurablePrivateJson(join(f.state, 'network-access.json'), { version: 1, mode: 'relay', serverUrl: 'https://relay.example', token: 'a'.repeat(43) });
  await f.manager.load();
  assert.deepEqual(f.manager.summary(), { enabledChannels: ['local', 'cloudflare', 'relay'], relayConfigured: true, serverUrl: 'https://relay.example', hasToken: true });
  await until(() => f.manager.snapshot().channels.filter(row => row.state === 'ready').length === 2);
  assert.equal(f.manager.preferredOrigin(), 'https://relay.example/r/' + 'a'.repeat(24));
  const saved = JSON.parse(await readFile(join(f.state, 'connection-channels.json'), 'utf8'));
  assert.equal(saved.version, 2); assert.equal(saved.relay.token, 'a'.repeat(43));
  assert.equal((await stat(join(f.state, 'connection-channels.json'))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(f.manager.snapshot()).includes('a'.repeat(43)));
  await f.manager.setEnabled(['local']); slow.resolve('https://late.example');
  await until(() => f.transports.find(row => row.config.kind === 'cloudflare')?.closed === true);
  assert.deepEqual(f.manager.summary().enabledChannels, ['local']);
  assert.deepEqual(f.manager.candidates(), f.local.channels);
});

test('explicit checkbox choices survive restart and an unconfigured Relay has no available checkbox', async t => {
  const f = await fixture(t); await f.manager.load(); assert.equal(f.manager.summary().relayConfigured, false);
  await assert.rejects(f.manager.setEnabled(['relay']), /relay-not-configured/);
  await f.manager.setEnabled([]); await f.manager.close();
  const restored = new ConnectionChannelsManager({ ...f.manager.options, transportFactory: () => { throw Error('disabled channel started'); }, startLocal: async () => { throw Error('disabled LAN started'); } });
  t.after(() => restored.close()); await restored.load();
  assert.deepEqual(restored.summary().enabledChannels, []); assert.deepEqual(restored.candidates(), []); assert.equal(restored.snapshot().overallState, 'disabled');
});

test('Cloudflare keeps a known unverified candidate after local probe failure and only existing authenticated confirmations can make it ready', async t => {
  const f = await fixture(t, { verify: (/** @type {string} */ kind) => { if (kind === 'cloudflare') throw Error('fixture-local-DNS-failure'); } }); await f.manager.load();
  await until(() => f.manager.snapshot().channels.some(row => row.kind === 'cloudflare' && row.state === 'unverified'));
  assert.ok(f.manager.candidates().some(row => row.url === 'https://direct.example'));
  assert.equal(f.manager.snapshot().overallState, 'ready');
  assert.equal(f.manager.confirm('cloudflare', 'https://foreign.example'), false);
  assert.equal(f.manager.confirm('cloudflare', 'https://direct.example'), true);
  assert.equal(f.manager.snapshot().channels.find(row => row.kind === 'cloudflare')?.state, 'ready');
  await f.manager.setEnabled(['local']);
  assert.equal(f.manager.confirm('cloudflare', 'https://direct.example'), false);
  assert.deepEqual(f.manager.candidates(), f.local.channels);
});

test('late LAN startup and stale transport callbacks are closed and fenced after disabling or shutdown', async t => {
  const slow = deferred(), f = await fixture(t, { localStart: slow.promise }); await f.manager.load();
  await f.manager.setEnabled(['cloudflare']); slow.resolve(f.local);
  await until(() => f.local.closed); assert.ok(!f.manager.candidates().some(row => row.kind === 'local'));
  await until(() => f.transports.length === 1); const transport = f.transports[0];
  await f.manager.close(); transport.emit('connected', 'https://stale.example');
  assert.deepEqual(f.manager.candidates(), []); assert.equal(f.manager.snapshot().overallState, 'disabled');
});

test('Relay replacement proves its owned route before persistence and never reuses another server credential', async t => {
  const f = await fixture(t, { verify: (/** @type {string} */ _kind, /** @type {string} */ url) => { if (url.includes('bad.example')) throw Error('fixture-probe-failure'); }, transport: (/** @type {Value} */ config) => config.kind === 'relay' && !config.token ? { fail: true } : {} });
  await f.manager.load(); await f.manager.configureRelay({ serverUrl: 'https://good.example', token: 'a'.repeat(43) });
  const old = f.transports.find(row => row.config.kind === 'relay'); assert.ok(old);
  await assert.rejects(f.manager.configureRelay({ serverUrl: 'https://bad.example', token: 'b'.repeat(43) }));
  assert.equal(old.closed, false); assert.equal(f.manager.summary().serverUrl, 'https://good.example');
  await assert.rejects(f.manager.configureRelay({ serverUrl: 'https://another.example' }));
  assert.equal(f.transports.at(-1)?.config.token, '');
  const saved = JSON.parse(await readFile(join(f.state, 'connection-channels.json'), 'utf8'));
  assert.equal(saved.relay.serverUrl, 'https://good.example'); assert.equal(saved.relay.token, 'a'.repeat(43));
  await f.manager.setEnabled(['local']);
  await f.manager.configureRelay({ serverUrl: 'https://next.example', token: 'c'.repeat(43) });
  assert.deepEqual(f.manager.summary().enabledChannels, ['local']);
  assert.ok(f.transports.at(-1)?.closed); assert.ok(!f.manager.candidates().some(row => row.kind === 'relay'));
});

test('a replacement cancelled by a newer checkbox change cannot overwrite persisted settings', async t => {
  const slow = deferred(), f = await fixture(t, { transport: (/** @type {Value} */ config) => config.kind === 'relay' && config.serverUrl.includes('slow.example') ? { start: slow.promise } : {} });
  await f.manager.load(); await f.manager.configureRelay({ serverUrl: 'https://good.example', token: 'a'.repeat(43) });
  const replacing = f.manager.configureRelay({ serverUrl: 'https://slow.example', token: 'b'.repeat(43) }); replacing.catch(() => {});
  await until(() => f.transports.some(row => row.config.serverUrl === 'https://slow.example'));
  await f.manager.setEnabled(['local']); slow.resolve('https://slow.example/r/' + 'a'.repeat(24));
  await assert.rejects(replacing, /cancelled/);
  assert.equal(f.manager.summary().serverUrl, 'https://good.example'); assert.deepEqual(f.manager.summary().enabledChannels, ['local']);
});

test('LAN advertisements reject loopback and public host URLs while preserving the public entries', async t => {
  const f = await fixture(t, { localStart: Promise.resolve({ channels: [{ id: 'unsafe', kind: 'local', url: 'http://127.0.0.1:8080' }], close() {} }) }); await f.manager.load();
  await until(() => f.manager.snapshot().channels.some(row => row.kind === 'local' && row.state === 'unavailable'));
  assert.ok(!f.manager.candidates().some(row => row.kind === 'local'));
  await until(() => f.manager.snapshot().channels.some(row => row.kind === 'cloudflare' && row.state === 'ready'));
});

test('transport construction failure is isolated and a late reconnect probe cannot revive a disconnected entry', async t => {
  const f = await fixture(t);
  const original = f.manager.options.transportFactory;
  f.manager.options.transportFactory = (config, seed) => { if (config.kind === 'cloudflare') throw Error('fixture-constructor-failed'); if (!original) throw Error('fixture factory missing'); return original(config, seed); };
  await f.manager.load();
  await until(() => f.manager.snapshot().channels.some(row => row.kind === 'local' && row.state === 'ready'));
  assert.equal(f.manager.snapshot().channels.find(row => row.kind === 'cloudflare')?.state, 'unavailable');
  await f.manager.configureRelay({ serverUrl: 'https://good.example', token: 'a'.repeat(43) });
  const relay = f.transports.find(row => row.config.kind === 'relay'); assert.ok(relay);
  const verify = deferred(); f.manager.options.probesFor = () => ({ verify: async () => { await verify.promise; } });
  relay.emit('disconnected'); relay.emit('connected');
  assert.equal(f.manager.snapshot().channels.find(row => row.kind === 'relay')?.state, 'unverified');
  relay.emit('disconnected'); verify.resolve(undefined);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.manager.snapshot().channels.find(row => row.kind === 'relay')?.state, 'reconnecting');
  assert.equal(f.manager.confirm('relay', 'https://good.example/r/' + 'a'.repeat(24)), true);
});

test('changing another checkbox does not cancel first Relay configuration and the new available Relay gets its default choice', async t => {
  const slow = deferred(), f = await fixture(t, { transport: (/** @type {Value} */ config) => config.kind === 'relay' ? { start: slow.promise } : {} }); await f.manager.load();
  const configuring = f.manager.configureRelay({ serverUrl: 'https://first.example', token: 'a'.repeat(43) });
  await until(() => f.transports.some(row => row.config.kind === 'relay'));
  await f.manager.setEnabled([]); slow.resolve('https://first.example/r/' + 'a'.repeat(24)); await configuring;
  assert.deepEqual(f.manager.summary().enabledChannels, ['relay']);
  assert.equal(f.manager.summary().serverUrl, 'https://first.example');
});
