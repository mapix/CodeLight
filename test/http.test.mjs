import test from 'node:test';
import assert from 'node:assert/strict';
import { startBridge } from '../src/server.mjs';
import { SessionStorage } from '../src/storage.mjs';
import { BridgeError } from '../src/errors.mjs';

class FixtureStorage extends SessionStorage {
  /** @param {'codex'|'zcode'} app */
  async list(app) { return [{ app, id: 'fixture_session', title: '专用验证会话', workspace: '/fixture', updatedAt: 1000 }]; }
  /** @param {import('../src/address.mjs').SessionAddress} address */
  async snapshot(address) { return { app: address.app, items: [], session: { id: address.id }, live: false, source: 'persisted' }; }
}

test('native pairing uses single-use code and Bearer; browser origin protection and logout remain enforced', async () => {
  let writes = 0;
  const adapter = {
    async status() { return { connected: true }; },
    /** @param {string} _id */
    async snapshot(_id) { return { text: 'native' }; },
    /** @param {string} _id @param {(value:unknown)=>void} receive */
    async subscribe(_id, receive) { receive({ text: 'native' }); return () => {}; },
    /** @param {string} _id @param {string} _action @param {unknown} _payload @param {string} _commandId */
    async command(_id, _action, _payload, _commandId) { writes++; return { admitted: true }; }
  };
  const bridge = await startBridge({ port: 0, storage: new FixtureStorage(), adapters: { codex: adapter } });
  const url = `http://127.0.0.1:${bridge.port}`;
  try {
    const code = bridge.auth.pairCode;
    assert.equal((await fetch(`${url}/api/pair`, { method: 'POST', body: JSON.stringify({ code }) })).status, 403);
    assert.equal((await fetch(`${url}/api/native/pair`, { method: 'POST', headers: { Origin: 'https://wrong.example' }, body: JSON.stringify({ code }) })).status, 403);
    assert.equal((await fetch(`${url}/api/native/pair`, { method: 'POST', body: JSON.stringify({ code: 'invalid' }) })).status, 401);
    const pair = await fetch(`${url}/api/native/pair`, { method: 'POST', body: JSON.stringify({ code }) });
    assert.equal(pair.status, 200); assert.equal(pair.headers.get('set-cookie'), null);
    const { credential, instanceId } = await pair.json();
    assert.match(credential, /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
    assert.equal((await fetch(`${url}/api/native/pair`, { method: 'POST', body: JSON.stringify({ code }) })).status, 401);
    const headers = { Authorization: `Bearer ${credential}` };
    assert.equal((await fetch(`${url}/api/status`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/api/status`, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
    const endpoint = `${url}/api/command?app=codex&id=fixture_session`;
    const body = JSON.stringify({ instanceId, commandId: 'native_auth_cmd', action: 'send', payload: { text: 'fixture' } });
    assert.equal((await fetch(endpoint, { method: 'POST', body })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Cookie: `bridge_session=${credential}` }, body })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://wrong.example' }, body })).status, 403);
    assert.equal(writes, 0);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 200);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 200);
    assert.equal(writes, 1);
    assert.equal((await fetch(`${url}/api/native/logout`, { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(`${url}/api/status`, { headers })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 401);
    assert.equal(writes, 1);
  } finally { await bridge.close(); }
});

test('HTTP authentication, origin protection, session-bound command receipts and SSE', async () => {
  let writes = 0;
  let activeSubscriptions = 0;
  const adapter = {
    async status() { return { connected: true }; },
    /** @param {string} id */
    async snapshot(id) { return { id, text: 'snapshot' }; },
    /** @param {string} id @param {(frame:unknown)=>void} callback */
    async subscribe(id, callback) {
      activeSubscriptions++; callback({ id, text: 'live' });
      return () => { activeSubscriptions--; };
    },
    /** @param {string} _id @param {string} _action @param {unknown} _payload @param {string} _commandId */
    async command(_id, _action, _payload, _commandId) { writes++; return { admitted: true }; }
  };
  const bridge = await startBridge({ port: 0, storage: new FixtureStorage(), adapters: { codex: adapter } });
  const url = `http://127.0.0.1:${bridge.port}`;
  try {
    assert.equal((await fetch(`${url}/api/status`)).status, 401);
    assert.equal((await fetch(`${url}/api/pair`, { method: 'POST', headers: { Origin: 'https://wrong.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${url}/api/pair`, { method: 'POST', headers: { Origin: url }, body: 'null' })).status, 400);
    const paired = await fetch(`${url}/api/pair`, { method: 'POST', headers: { Origin: url }, body: JSON.stringify({ code: bridge.auth.pairCode }) });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie')?.split(';')[0] ?? '';
    const headers = { Cookie: cookie, Origin: url };
    const status = await fetch(`${url}/api/status`, { headers }).then((response) => response.json());
    const sessions = await fetch(`${url}/api/sessions?app=codex`, { headers }).then((response) => response.json());
    assert.equal(sessions.sessions[0].app, 'codex');
    assert.equal((await fetch(`${url}/api/snapshot?app=codex&id=..%2Fsecret`, { headers })).status, 400);
    const payload = { commandId: 'operation_123', instanceId: status.instanceId, action: 'send', payload: { text: 'test' } };
    const endpoint = `${url}/api/command?app=codex&id=fixture_session`;
    const result = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) }).then((response) => response.json());
    assert.equal(result.receipt.status, 'complete');
    await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal(writes, 1);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...payload, instanceId: 'old-instance' }) })).status, 409);
    assert.equal((await fetch(`${url}/api/command?app=zcode&id=fixture_session`, { method: 'POST', headers, body: JSON.stringify(payload) })).status, 503);
    const stream = await fetch(`${url}/api/events?app=codex&id=fixture_session`, { headers });
    const reader = stream.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: native/);
    assert.equal(activeSubscriptions, 1);
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(activeSubscriptions, 0);
    const page = await fetch(url);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.ok(!(await page.text()).includes(bridge.auth.pairCode));
  } finally { await bridge.close(); }
});

test('an open phone stream recovers when the original desktop owner becomes available', async () => {
  let attempts = 0, released = 0;
  const adapter = {
    async status() { return { connected: true }; },
    /** @param {string} _id */
    async snapshot(_id) { return {}; },
    /** @param {string} _id @param {(frame:unknown)=>void} receive */
    async subscribe(_id, receive) {
      attempts++;
      if (attempts === 1) throw new BridgeError('owner-unavailable', 'Owner not ready.', 503);
      receive({ ready: true }); return () => { released++; };
    },
    /** @param {string} _id @param {string} _action @param {unknown} _payload @param {string} _commandId */
    async command(_id, _action, _payload, _commandId) { assert.fail('read recovery must not dispatch mutations'); }
  };
  const bridge = await startBridge({ port: 0, storage: new FixtureStorage(), adapters: { codex: adapter }, subscribeRetryMs: 10 });
  try {
    const pair = bridge.auth.pair(bridge.auth.pairCode, 'fixture');
    const stream = await fetch(`http://127.0.0.1:${bridge.port}/api/events?app=codex&id=fixture_session`, { headers: { Cookie: `bridge_session=${pair.cookie}` } });
    const reader = stream.body?.getReader(); assert.ok(reader);
    let text = '';
    for (let at = 0; at < 4 && !text.includes('"ready":true'); at++) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /owner-unavailable/); assert.match(text, /"ready":true/);
    assert.equal(attempts, 2); await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(released, 1);
    const atClose = attempts; await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(attempts, atClose);
  } finally { await bridge.close(); }
});

test('historical snapshot exposes safe original-owner unavailability instead of implying a live session', async () => {
  const adapter = {
    async status() { return { connected: true }; },
    /** @param {string} _id */
    async snapshot(_id) { throw new BridgeError('codex-owner-unavailable', 'The session has no existing desktop owner.', 409); },
    /** @param {string} _id @param {(value:unknown)=>void} _receive */
    async subscribe(_id, _receive) { return () => {}; },
    /** @param {string} _id @param {string} _action @param {unknown} _payload @param {string} _commandId */
    async command(_id, _action, _payload, _commandId) { assert.fail('read-only snapshot must not dispatch'); }
  };
  const bridge = await startBridge({ port: 0, storage: new FixtureStorage(), adapters: { codex: adapter } });
  try {
    const pair = bridge.auth.pair(bridge.auth.pairCode, 'fixture');
    const data = await fetch(`http://127.0.0.1:${bridge.port}/api/snapshot?app=codex&id=fixture_session`, { headers: { Authorization: `Bearer ${pair.cookie}` } }).then(r => r.json());
    assert.equal(data.live, false); assert.equal(data.native, null); assert.equal(data.persisted.source, 'persisted');
    assert.equal(data.nativeUnavailable.error, 'codex-owner-unavailable'); assert.equal(data.nativeUnavailable.status, 409);
    assert.equal(data.nativeUnavailable.stack, undefined);
  } finally { await bridge.close(); }
});
