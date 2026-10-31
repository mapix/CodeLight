import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { io } from 'socket.io-client';
import { CodeLightMacDaemon } from '../src/happy/mac-daemon.mjs';
import { sourceKey } from '../src/happy/source-registry.mjs';
import { encryptRecord, decryptRecord } from '../src/happy/session-transport.mjs';
import { BridgeError } from '../src/errors.mjs';

/** @typedef {Record<string,any>} Value */
test('real self-host machine RPC: discovery metadata, once, unknown restart and no model runner', { skip: process.env.CODELIGHT_DISCOVERY_INTEGRATION !== '1' }, async () => {
  const serverUrl = process.env.CODELIGHT_DISCOVERY_TEST_ORIGIN ?? 'http://127.0.0.1:57070';
  const secret = new Uint8Array(randomBytes(32)), signer = nacl.sign.keyPair.fromSeed(secret), challenge = randomBytes(32);
  const auth = await fetch(`${serverUrl}/v1/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey: Buffer.from(signer.publicKey).toString('base64'), challenge: challenge.toString('base64'), signature: Buffer.from(nacl.sign.detached(challenge, signer.secretKey)).toString('base64') }) });
  assert.equal(auth.status, 200); const account = { serverUrl, secret: Buffer.from(secret).toString('base64'), token: (await auth.json()).token };
  const directory = await mkdtemp(join(tmpdir(), 'codelight-discovery-live-'));
  const source = { app: 'codex', hostId: 'local', id: 'fixture-only-not-a-real-native-session', kind: 'session', title: 'TEST ONLY — discovery has no real native adapter' }, key = sourceKey(source);
  let opened = 0, started = 0, fail = false;
  const options = { directory, account, discovery: { discover: async () => ({ sources: [source] }), adapter: () => ({}) }, sourceFactory: async () => ({ openDesktop: async () => { opened++; if (fail) throw new BridgeError('delivery-unknown', 'Fixture lost original-open ACK; no real app exists.'); }, start: async () => { started++; }, status: () => ({ sourceStatus: 'connected' }), close: async () => {} }) };
  let daemon = new CodeLightMacDaemon(options);
  const peer = io(serverUrl, { path: '/v1/updates', auth: { token: account.token, clientType: 'user-scoped' }, transports: ['websocket'], autoConnect: false });
  /** @param {string} method @param {Value} params */
  const call = async (method, params) => {
    const result = /** @type {Value} */ (await peer.timeout(15000).emitWithAck('rpc-call', { method: `${daemon.machine?.id}:${method}`, params: encryptRecord(params, secret, 'legacy') }));
    assert.equal(result.ok, true); return /** @type {Value} */ (decryptRecord(result.result, secret, 'legacy'));
  };
  /** @type {string|null} */ let sessionId = null;
  try {
    await daemon.start(); sessionId = daemon.sources.get(key)?.binding.happySessionId;
    assert.equal(opened, 0); assert.equal(started, 0); assert.equal(daemon.status().activeSources, 0);
    const entry = daemon.sources.get(key); assert.ok(entry); assert.equal(entry.binding.metadata.bridge.controller, 'machine'); assert.equal(entry.binding.metadata.bridge.sourceKey, key);
    await new Promise((resolveWait, reject) => { peer.once('connect', () => resolveWait(undefined)); peer.once('connect_error', reject); peer.connect(); });
    const request = { sourceKey: key, commandId: 'fixture-live-open-once' };
    assert.equal((await call('codelight-open-source', request)).receipt.status, 'complete');
    assert.equal((await call('codelight-open-source', request)).receipt.status, 'complete'); assert.equal(opened, 1); assert.equal(started, 1);
    fail = true; const unknown = { sourceKey: key, commandId: 'fixture-live-open-unknown' };
    assert.equal((await call('codelight-open-source', unknown)).receipt.status, 'unknown'); assert.equal(opened, 2);
    await daemon.close(); fail = false; daemon = new CodeLightMacDaemon(options); await daemon.start(); await Promise.all([...daemon.activating.values()]);
    assert.equal(opened, 2); assert.equal((await call('codelight-receipt', { commandId: unknown.commandId })).receipt.status, 'unknown');
    assert.equal((await call('codelight-open-source', unknown)).receipt.status, 'unknown'); assert.equal(opened, 2);
    const selection = { sourceKey: key, commandId: 'fixture-select-first', selectionClient: 'fixture-phone', selectionSeq: 1 };
    assert.equal((await call('codelight-select-source', selection)).receipt.status, 'complete');
    assert.equal((await call('codelight-select-source', { ...selection, commandId: 'fixture-select-again', selectionSeq: 2 })).receipt.status, 'complete');
    assert.equal(opened, 4);
    assert.equal((await call('codelight-select-source', { ...selection, commandId: 'fixture-select-stale' })).receipt.error, 'selection-superseded');
    assert.equal((await call('codelight-observe-source', { sourceKey: key, commandId: 'fixture-passive-observe' })).receipt.status, 'complete'); assert.equal(opened, 4);
    console.log(JSON.stringify({ codeLightMachineLive: true, registeredSources: 1, fixtureOpens: opened, restoredObserverStarts: started, nativeRedispatchesAfterUnknown: 0, realNativeCalls: 0, modelRunnersStarted: 0 }));
  } finally {
    peer.removeAllListeners(); peer.disconnect(); await daemon.close();
    if (sessionId) await fetch(`${serverUrl}/v1/sessions/${sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${account.token}` } }).catch(() => {});
    await rm(directory, { recursive: true, force: true }); signer.secretKey.fill(0); secret.fill(0);
  }
});
