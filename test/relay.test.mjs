import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startRelay } from '../src/relay.mjs';
import { startConnector, manageConnector } from '../src/relay-connector.mjs';
import { startBridge } from '../src/server.mjs';
import { SessionStorage } from '../src/storage.mjs';

test('authenticated relay forwards pairing, HTTP and streaming without replaying writes', async () => {
  const token = randomBytes(32).toString('base64url');
  const relay = await startRelay({ port: 0, token });
  const origin = `http://127.0.0.1:${relay.port}`;
  let subscriptions = 0; let writes = 0;
  class Store extends SessionStorage {
    /** @param {'codex'|'zcode'} _app */
    async list(_app) { return []; }
  }
  const adapter = {
    async status() { return { connected: true }; },
    /** @param {string} _id */
    async snapshot(_id) { return {}; },
    /** @param {string} _id @param {(value:unknown)=>void} receive */
    async subscribe(_id, receive) { subscriptions++; receive({ text: 'live' }); return () => { subscriptions--; }; },
    /** @param {string} _id @param {string} _action @param {unknown} _payload @param {string} _commandId */
    async command(_id, _action, _payload, _commandId) { writes++; return { accepted: true }; }
  };
  const bridge = await startBridge({ port: 0, relayOrigin: origin, storage: new Store(), adapters: { codex: adapter } });
  const localUrl = `http://127.0.0.1:${bridge.port}`;
  /** @type {{close:()=>void}|undefined} */
  let connector;
  try {
    assert.equal((await fetch(origin)).status, 503);
    await assert.rejects(startConnector({ relayUrl: origin.replace('http:', 'ws:'), localUrl, token: 'wrong' }));
    connector = await startConnector({ relayUrl: origin.replace('http:', 'ws:'), localUrl, token });
    assert.equal((await fetch(`${origin}/api/status`)).status, 401);
    const paired = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ code: bridge.auth.pairCode }) });
    assert.equal(paired.status, 200);
    const headers = { Cookie: paired.headers.get('set-cookie')?.split(';')[0] ?? '', Origin: origin };
    const status = await fetch(`${origin}/api/status`, { headers }).then((response) => response.json());
    const command = { instanceId: status.instanceId, commandId: 'relay_cmd_123', action: 'send', payload: { text: 'test' } };
    assert.equal((await fetch(`${origin}/api/command?app=codex&id=fixture`, { method: 'POST', headers, body: JSON.stringify(command) })).status, 200);
    await fetch(`${origin}/api/command?app=codex&id=fixture`, { method: 'POST', headers, body: JSON.stringify(command) });
    assert.equal(writes, 1);
    const stream = await fetch(`${origin}/api/events?app=codex&id=fixture`, { headers });
    const reader = stream.body?.getReader(); assert.ok(reader);
    assert.match(new TextDecoder().decode((await reader.read()).value), /live/);
    assert.equal(subscriptions, 1);
    connector.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(subscriptions, 0);
    assert.equal(relay.pending.size, 0);
    assert.equal(writes, 1);
    assert.equal((await fetch(origin)).status, 503);
  } finally { connector?.close(); await bridge.close(); await relay.close(); }
});

test('remote plain websocket and nonlocal upstream are rejected', async () => {
  await assert.rejects(startConnector({ relayUrl: 'ws://example.invalid', localUrl: 'http://127.0.0.1:1', token: 'x' }));
  await assert.rejects(startConnector({ relayUrl: 'ws://127.0.0.1:1', localUrl: 'http://example.invalid', token: 'x' }));
});

test('relay forwards native Bearer separately from its connector credential and revokes on logout', async () => {
  const token = randomBytes(32).toString('base64url');
  const relay = await startRelay({ port: 0, token });
  const origin = `http://127.0.0.1:${relay.port}`;
  let writes = 0;
  const adapter = {
    async status() { return { connected: true }; },
    /** @param {string} _id */
    async snapshot(_id) { return {}; },
    /** @param {string} _id @param {(value:unknown)=>void} receive */
    async subscribe(_id, receive) { receive({ text: 'native relay' }); return () => {}; },
    /** @param {string} _id @param {string} _action @param {unknown} _payload @param {string} _commandId */
    async command(_id, _action, _payload, _commandId) { writes++; return { admitted: true }; }
  };
  const bridge = await startBridge({ port: 0, relayOrigin: origin, adapters: { codex: adapter } });
  const connector = await startConnector({ relayUrl: origin.replace('http:', 'ws:'), localUrl: `http://127.0.0.1:${bridge.port}`, token });
  try {
    assert.equal((await fetch(`${origin}/api/status`)).status, 401);
    assert.equal((await fetch(`${origin}/api/status`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    const pair = await fetch(`${origin}/api/native/pair`, { method: 'POST', body: JSON.stringify({ code: bridge.auth.pairCode }) });
    assert.equal(pair.status, 200);
    const { credential, instanceId } = await pair.json();
    const headers = { Authorization: `Bearer ${credential}` };
    assert.equal((await fetch(`${origin}/api/status`, { headers })).status, 200);
    const endpoint = `${origin}/api/command?app=codex&id=fixture`;
    const body = JSON.stringify({ instanceId, commandId: 'relay_native_123', action: 'send', payload: { text: 'fixture' } });
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 200);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 200);
    assert.equal(writes, 1);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://wrong.example' }, body })).status, 403);
    assert.equal((await fetch(`${origin}/api/native/logout`, { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(`${origin}/api/status`, { headers })).status, 401);
    assert.equal(writes, 1);
  } finally { connector.close(); await bridge.close(); await relay.close(); }
});

test('managed connector reconnects to the relay and does not retain old HTTP jobs', async () => {
  const token = randomBytes(32).toString('base64url');
  let relay = await startRelay({ port: 0, token });
  const port = relay.port;
  /** @type {string[]} */ const states = [];
  const manager = manageConnector({ relayUrl: `ws://127.0.0.1:${port}`, localUrl: 'http://127.0.0.1:1', token,
    minBackoffMs: 20, maxBackoffMs: 40, onStatus: (status) => states.push(status) });
  /** @param {number} count */
  async function connected(count) {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (states.filter((status) => status === 'connected').length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('connector did not reconnect');
  }
  try {
    await connected(1); await relay.close();
    relay = await startRelay({ port, token }); await connected(2);
    assert.equal(relay.pending.size, 0);
    assert.ok(states.includes('reconnecting'));
  } finally { await manager.close(); await relay.close(); }
});
