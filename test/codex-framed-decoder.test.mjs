import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexIpcAdapter } from '../src/adapters/codex-ipc.mjs';

test('large fragmented snapshots are decoded with linear buffer copying before the following control frame', () => {
  const snapshot = { type: 'broadcast', text: 'x'.repeat(1024 * 1024) }, control = { type: 'response', id: 'control' };
  /** @param {Record<string,any>} value */
  const encode = value => { const body=Buffer.from(JSON.stringify(value)), frame=Buffer.alloc(body.length+4);frame.writeUInt32LE(body.length);body.copy(frame,4);return frame; };
  const bytes = Buffer.concat([encode(snapshot), encode(control)]), adapter = new CodexIpcAdapter();
  /** @type {Record<string,any>[]} */ const received = [];
  adapter.handle = frame => { received.push(frame); };
  const concat = Buffer.concat; let copied = 0;
  Buffer.concat = (parts, length) => { copied += parts.reduce((sum, part) => sum + part.length, 0); return concat(parts, length); };
  try { for (let i=0;i<bytes.length;i+=16384) adapter.consume(bytes.subarray(i,i+16384)); }
  finally { Buffer.concat=concat; adapter.dispose(); }
  assert.deepEqual(received,[snapshot,control]);
  assert.ok(copied <= bytes.length*3, `fragment accumulation copied ${copied} for ${bytes.length} bytes`);
});

test('fragmented length headers retain the existing invalid-frame limits', () => {
  const adapter = new CodexIpcAdapter(); const header=Buffer.alloc(4);header.writeUInt32LE(0);
  adapter.consume(header.subarray(0,2));
  assert.throws(()=>adapter.consume(header.subarray(2)),{code:'codex-frame-too-large'});adapter.dispose();
});
