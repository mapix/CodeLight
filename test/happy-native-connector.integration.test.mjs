import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { HappySessionTransport, deriveContentKeyPair, encryptRecord, sealDataKey } from '../src/happy/session-transport.mjs';
import { NativeHappyConnector } from '../src/happy/native-connector.mjs';
import { CommandReceipts } from '../src/commands.mjs';
import { BridgeError } from '../src/errors.mjs';

/** @typedef {Record<string,any>} Value */
const env = process.env;
const createIdentity = env.HAPPY_CONNECTOR_CREATE_TEST_ACCOUNT === '1';
const enabled = env.HAPPY_CONNECTOR_INTEGRATION === '1' && (createIdentity || env.HAPPY_CONNECTOR_TEST_ORIGIN && env.HAPPY_CONNECTOR_TEST_TOKEN && env.HAPPY_CONNECTOR_TEST_SESSION_ID && env.HAPPY_CONNECTOR_TEST_SESSION_KEY);

class TestOnlyAdapter {
  constructor() { this.view = /** @type {Value} */ ({ rows: [], requests: [], status: 'idle', currentTurnId: null, revision: 1 }); this.calls = /** @type {Value[]} */ ([]); this.callback = /** @type {((view:Value)=>void)|null} */ (null); this.fail = false; }
  async snapshot(/** @type {string} */ _id) { return structuredClone(this.view); }
  async subscribe(/** @type {string} */ _id, /** @type {(view:Value)=>void} */ callback) { this.callback = callback; callback(this.view); return () => { this.callback = null; }; }
  emit() { this.view.revision++; this.callback?.(structuredClone(this.view)); }
  async command(/** @type {string} */ _id, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId) {
    this.calls.push({ action, payload, commandId });
    if (this.fail) throw new BridgeError('delivery-unknown', 'Test adapter ACK lost; no real model exists.');
    if (action === 'interrupt') { this.view.currentTurnId = null; this.view.status = 'idle'; this.emit(); return { interruptedTurnId: payload.turnId, acknowledged: true }; }
    const turn = this.view.currentTurnId ?? 'fixture-only-turn'; this.view.currentTurnId = turn; this.view.status = 'active';
    this.view.rows.push({ id: `test-row-${this.calls.length}`, commandId, role: 'user', text: payload.text, turnId: turn, status: 'inProgress' }); this.emit();
    return { acknowledged: true, turnId: turn };
  }
}

/** @param {()=>Promise<boolean>} condition */
async function until(condition) { for (let i = 0; i < 100; i++) { if (await condition()) return; await new Promise(resolveWait => setTimeout(resolveWait, 25)); } throw Error('Isolated Happy fixture did not reach the expected state.'); }

test('real Happy records with fixture-only native adapter: once, accepted identity, unknown restart and stream', { skip: !enabled }, async () => {
  let origin = env.HAPPY_CONNECTOR_TEST_ORIGIN, token = env.HAPPY_CONNECTOR_TEST_TOKEN, sessionId = env.HAPPY_CONNECTOR_TEST_SESSION_ID, encodedKey = env.HAPPY_CONNECTOR_TEST_SESSION_KEY;
  if (createIdentity) {
    origin ??= 'http://127.0.0.1:57070';
    const url = new URL(origin);
    const localFixture = ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '57070';
    assert.ok(localFixture || env.HAPPY_CONNECTOR_ALLOW_REMOTE_FIXTURE === '1', 'Remote fresh identity needs an explicit fixture-only flag.');
    assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/');
    // 全新测试身份只在RAM；不读Root account或原用户credentials，不挂真实native source。
    const seed = new Uint8Array(randomBytes(32)), signer = nacl.sign.keyPair.fromSeed(seed), challenge = randomBytes(32);
    const auth = await fetch(`${origin}/v1/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey: Buffer.from(signer.publicKey).toString('base64'), challenge: challenge.toString('base64'), signature: Buffer.from(nacl.sign.detached(challenge, signer.secretKey)).toString('base64') }) });
    assert.equal(auth.status, 200); const authenticated = await auth.json(); assert.equal(authenticated.success, true); token = authenticated.token;
    const key = new Uint8Array(randomBytes(32)), pair = deriveContentKeyPair(seed);
    const metadata = { path: '', host: 'isolated-fixture', client: { id: 'transport-fixture', name: 'TEST ONLY — no native SDK', version: '1' }, testOnly: true };
    const created = await fetch(`${origin}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ tag: `connector-fixture-${randomUUID()}`, metadata: encryptRecord(metadata, key), dataEncryptionKey: Buffer.from(sealDataKey(key, pair.publicKey)).toString('base64') }) });
    assert.equal(created.status, 200); sessionId = (await created.json()).session.id; encodedKey = Buffer.from(key).toString('base64');
  }
  assert.ok(origin && token && sessionId && encodedKey);
  const key = new Uint8Array(Buffer.from(encodedKey, 'base64')), directory = await mkdtemp(join(tmpdir(), 'happy-connector-live-fixture-'));
  const common = { serverOrigin: origin, token, sessionId, encryptionKey: key, pollMs: 0, requestTimeoutMs: 10000 };
  let source = new HappySessionTransport({ ...common, statePath: join(directory, 'source.json') });
  const peer = new HappySessionTransport({ ...common, statePath: join(directory, 'peer.json') });
  const adapter = new TestOnlyAdapter();
  const options = { adapter, nativeId: 'fixture-native-not-a-real-sdk', sourceIdentity: { app: 'codex', id: 'fixture-native-not-a-real-sdk', hostId: 'fixture-only' }, bindingId: `fixture-${sessionId}`, statePath: join(directory, 'connector.json'), encryptionKey: key, getGeneration: () => 'fixture-owner-1', assertLease: () => true, admissionTimeoutMs: 1000,
    metadata: { path: '', host: 'fixture-only', client: { id: 'noninvasive-bridge', name: 'TEST ONLY — no real native source', version: '1' }, testOnly: true } };
  let connector = new NativeHappyConnector({ ...options, transport: source, receipts: await CommandReceipts.load(join(directory, 'receipts.json')) });
  try {
    await peer.start(); await connector.start();
    const localId = `fixture-user-${randomUUID()}`, message = { role: 'user', content: { type: 'text', text: 'Fixture transport to fake adapter only; never a real Agent instruction.' } };
    const happyAck = await peer.publish(localId, message);
    await until(async () => { await source.catchUp(); await connector.processInbox(); await peer.catchUp(); return adapter.calls.length === 1 && peer.listInbox().some((/** @type {Value} */ incoming) => incoming.record?.content?.ev?.t === 'user-message-accepted' && incoming.record.content.ev.ref === happyAck.id); });
    const accepted = peer.listInbox().find((/** @type {Value} */ incoming) => incoming.record?.content?.ev?.t === 'user-message-accepted'); assert.ok(accepted); assert.equal(accepted.record.content.ev.runId, 'fixture-only-turn');
    await peer.publish(localId, message); await source.catchUp(); await connector.processInbox(); assert.equal(adapter.calls.length, 1);
    adapter.view.rows.push({ id: 'fixture-agent-text', role: 'assistant', text: 'first', turnId: 'fixture-only-turn', status: 'inProgress' }); await connector.project(adapter.view);
    adapter.view.rows.at(-1).text = 'first second'; await connector.project(adapter.view); await peer.catchUp();
    const fragments = peer.listInbox().flatMap((/** @type {Value} */ incoming) => incoming.record?.content?.ev?.t === 'text' && incoming.record.content.role === 'agent' ? [incoming.record.content.ev.text] : []);
    assert.ok(fragments.includes('first')); assert.ok(fragments.includes(' second')); assert.ok(!fragments.includes('first second'));
    adapter.fail = true; const unknownId = `fixture-unknown-${randomUUID()}`; await peer.publish(unknownId, { role: 'user', content: { type: 'text', text: 'Fixture unknown outcome only.' } });
    await until(async () => { await source.catchUp(); await connector.processInbox(); return adapter.calls.length === 2; });
    const unknownCommandId = adapter.calls[1].commandId;
    const unknown = /** @type {Value} */ (await peer.callRpc('bridge-receipt', { commandId: unknownCommandId })); assert.equal(unknown.receipt.status, 'unknown');
    await peer.catchUp();
    const unconfirmed = peer.listInbox().filter((/** @type {Value} */ incoming) => incoming.record?.content?.ev?.t === 'user-message-delivery-unknown');
    assert.equal(unconfirmed.length, 1); assert.equal(unconfirmed[0].record.content.ev.commandId, unknownCommandId);
    await connector.close(); await source.close();
    source = new HappySessionTransport({ ...common, statePath: join(directory, 'source-catchup-from-zero.json') });
    connector = new NativeHappyConnector({ ...options, transport: source, receipts: await CommandReceipts.load(join(directory, 'receipts.json')) }); await connector.start(); await connector.processInbox();
    assert.equal(adapter.calls.length, 2);
    const again = /** @type {Value} */ (await peer.callRpc('bridge-receipt', { commandId: unknownCommandId })); assert.equal(again.receipt.status, 'unknown');
    adapter.fail = false; await peer.callRpc('abort', { commandId: 'fixture-stop-native-once', turnId: 'fixture-only-turn' });
    await peer.callRpc('abort', { commandId: 'fixture-stop-native-once', turnId: 'fixture-only-turn' }); assert.equal(adapter.calls.length, 3);
    console.log(JSON.stringify({ happyConnectorFixtureLive: true, fixtureAdapterCalls: 3, unknownRedispatches: 0, unconfirmedMessageEvent: true, acceptedRefMatchesServerId: true, prefixDelta: true, actualNativeSdkCalls: 0, modelCalls: 0, guiActions: 0 }));
  } finally { await connector.close(); await Promise.allSettled([source.close(), peer.close()]); if (createIdentity) await fetch(`${origin}/v1/sessions/${sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
