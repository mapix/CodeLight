import test from 'node:test';
import assert from 'node:assert/strict';
import { closeOwnedResources, stopOwnedChildren } from '../src/happy/owned-shutdown.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('a failed observer close still stops owned children before releasing the service lease', async () => {
  /** @type {string[]} */ const order = [];
  await assert.rejects(closeOwnedResources([
    async () => { order.push('observer'); throw Error('fixture close'); },
    async () => { order.push('gateway'); },
  ], async () => { order.push('children-exited'); }, async () => { order.push('lease-released'); }), /fixture close/);
  assert.deepEqual(order, ['observer', 'gateway', 'children-exited', 'lease-released']);
});

test('a child stop failure cannot release the database service lease', async () => {
  let released = false;
  await assert.rejects(closeOwnedResources([], async () => { throw Error('fixture child alive'); }, async () => { released = true; }), /fixture child alive/);
  assert.equal(released, false);
});

test('a TERM-resistant real child is fully exited before lease release', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout, 'data');
  let released = false;
  await closeOwnedResources([], () => stopOwnedChildren([child], 10), async () => {
    assert.equal(child.signalCode, 'SIGKILL'); released = true;
  });
  assert.equal(released, true);
});
