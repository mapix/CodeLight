import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoundSource } from '../src/happy/bound-source.mjs';

/** @typedef {Record<string,any>} Value */
function gate() {
  let release = /** @type {()=>void} */ (() => {});
  const promise = /** @type {Promise<void>} */ (new Promise(resolve => { release = () => resolve(undefined); }));
  return { promise, release: () => release() };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-bound-source-')), calls = /** @type {Value[]} */ ([]);
  const adapter = { command: async (/** @type {string} */ id, /** @type {string} */ action) => { calls.push({ id, action }); return { requested: true }; }, dispose: () => { throw Error('original adapter must not be disposed'); } };
  const options = { directory: join(directory, 'active'), leaseDirectory: join(directory, 'leases'), account: { serverUrl: 'http://127.0.0.1:1', token: 'fixture-token' },
    binding: { source: { app: 'codex', hostId: 'local', id: 'fixture-original' }, happySessionId: 'fixture-bound', sessionKey: Buffer.alloc(32, 7).toString('base64'), metadata: {} }, adapter };
  const actor = await createBoundSource(options); let closes = 0;
  const originalClose = actor.transport.close.bind(actor.transport);
  actor.transport.close = async () => { closes++; await originalClose(); };
  actor.transport.updateMetadata = async () => null;
  return { directory, options, actor, calls, closes: () => closes, dispose: async () => { await actor.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('bound actor navigation pins retirement and release closes only CodeLight transport once', async () => {
  const f = await fixture(), entered = gate(), resume = gate();
  f.options.adapter.command = async (id, action) => { f.calls.push({ id, action }); entered.release(); await resume.promise; return { requested: true }; };
  try {
    const opening = f.actor.openDesktop('original-navigation'); await entered.promise;
    assert.equal(await f.actor.tryCloseIfIdle(), false); assert.equal(f.actor.status().closed, false);
    resume.release(); await opening;
    assert.equal(await f.actor.tryCloseIfIdle(), true); await f.actor.close(); assert.equal(f.closes(), 1);
    assert.deepEqual(f.calls, [{ id: 'fixture-original', action: 'open-desktop' }]);
  } finally { resume.release(); await f.dispose(); }
});

test('bound retirement fences late navigation and start while sharing the existing close pipeline', async () => {
  const f = await fixture(), entered = gate(), resume = gate();
  f.actor.transport.updateMetadata = async () => { entered.release(); await resume.promise; return null; };
  try {
    const first = f.actor.tryCloseIfIdle(), second = f.actor.tryCloseIfIdle(); await entered.promise;
    await assert.rejects(f.actor.openDesktop('late-navigation'), { code: 'source-lease-unavailable' });
    await assert.rejects(f.actor.start(), { code: 'source-unavailable' });
    const explicit = f.actor.close(); resume.release();
    assert.deepEqual(await Promise.all([first, second]), [true, true]); await explicit;
    assert.equal(f.closes(), 1); assert.deepEqual(f.calls, []);
    const replacement = await createBoundSource(f.options); await replacement.close();
  } finally { resume.release(); await f.dispose(); }
});
