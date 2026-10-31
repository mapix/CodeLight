import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeLightMachineConnection } from '../src/happy/machine-presence.mjs';
import { GatewayMetrics } from '../src/happy/gateway-metrics.mjs';
import { encryptRecord, decryptRecord } from '../src/happy/session-transport.mjs';

/** @typedef {Record<string,any>} Value */
test('machine RPC metrics receive only scoped method names and never alter encrypted results', async () => {
  const methods = /** @type {string[]} */ ([]), metrics = new GatewayMetrics(), key = new Uint8Array(32).fill(7);
  // Exercise the real RPC method with no network connection or original owner involved.
  const connection = /** @type {CodeLightMachineConnection} */ (Object.create(CodeLightMachineConnection.prototype));
  connection.options = { serverUrl: 'http://fixture.invalid', token: 'fixture', machineId: 'fixture-machine', accountSecret: key,
    onRpc: method => { methods.push(method); metrics.rpc(); } };
  connection.closed = false; connection.handlers = new Map([['fixture-read', (params) => ({ ok: true, count: /** @type {Value} */ (params).count })], ['fixture-fail', () => { throw Error('fixture'); }]]);
  const params = encryptRecord({ count: 2, secret: 'PRIVATE_PAYLOAD' }, key, 'legacy');
  const success = decryptRecord(await connection.serve({ method: 'fixture-machine:fixture-read', params }), key, 'legacy');
  assert.deepEqual(success, { ok: true, count: 2 });
  await connection.serve({ method: 'fixture-machine:fixture-fail', params });
  await connection.serve({ method: 'fixture-machine:unknown-method', params });
  await connection.serve({ method: 'foreign-machine:fixture-read', params });
  assert.deepEqual(methods, ['fixture-read', 'fixture-fail', 'unknown-method']); assert.equal(metrics.snapshot().rpcRequests, 3);
  connection.options.onRpc = () => { throw Error('metric sink failure'); };
  assert.deepEqual(decryptRecord(await connection.serve({ method: 'fixture-machine:fixture-read', params }), key, 'legacy'), { ok: true, count: 2 });
  await metrics.close();
});
