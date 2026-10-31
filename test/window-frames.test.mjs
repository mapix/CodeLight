import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowFrames } from '../src/window-frames.mjs';

test('window image addresses bind app and window, never expose filesystem paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-images-'));
  try {
    const path = join(directory, 'image.png'); await writeFile(path, 'fixture PNG');
    const frames = new WindowFrames(directory);
    const view = await frames.publish({ app: 'zcode', id: 'window_1' }, { kind: 'window', imagePath: path, captureStamp: { sample: true } });
    assert.ok(!('imagePath' in view));
    assert.match(view.imageUrl, /api\/window-image/);
    assert.equal((await frames.read({ app: 'zcode', id: 'window_1' }, view.frameId)).toString(), 'fixture PNG');
    await assert.rejects(frames.read({ app: 'codex', id: 'window_1' }, view.frameId));
    await assert.rejects(frames.read({ app: 'zcode', id: 'window_2' }, view.frameId));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('foreign capture paths fail closed and expired image records do not load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-image-boundary-'));
  const other = await mkdtemp(join(tmpdir(), 'bridge-image-foreign-'));
  try {
    const frames = new WindowFrames(directory);
    const path = join(other, 'foreign.png'); await writeFile(path, 'foreign');
    await assert.rejects(frames.publish({ app: 'zcode', id: 'window_1' }, { kind: 'window', imagePath: path }));
    await assert.rejects(frames.read({ app: 'zcode', id: 'window_1' }, 'nonexistent'));
  } finally { await rm(directory, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});
