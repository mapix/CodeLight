import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyPublicSourceSnapshot, publicSourcePath } from '../src/release/source-snapshot.mjs';

test('public source keeps current standalone inputs and excludes credentials and deferred prototype artifacts', () => {
  for (const name of ['apps/mobile/package.json', 'apps/mobile/sources/App.tsx', 'src/network/relay-server.mjs', 'packages/relay/.env.example', '.github/workflows/verify.yml', 'patches/image-size@1.2.1.patch', 'README.zh-CN.md']) assert.equal(publicSourcePath(name), true, name);
  for (const name of ['src/network-access.json', 'src/network-identity.json', 'apps/mobile/.xcode.env.local', 'src/key.pem', 'src/private/state.json', 'native/bin/helper', 'native/codelight-qa/Tests.swift', 'website/release.json', 'website/downloads/app.zip', 'apps/mobile/google-services.json', 'scripts/package.mjs', 'spec/delivery.md', 'spec/native-mobile-app.md', 'spec/native-mobile-transport.md', 'research/extracted.js', 'clients/happy/package.json', 'src/../account.json', 'src/.env', 'src/WORKLOG-private.md']) assert.equal(publicSourcePath(name), false, name);
});

test('a public source snapshot preserves task deletions and fails closed on external symlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-public-source-')), root = join(directory, 'input'), stage = join(directory, 'stage');
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['package.json', 'src/network/relay-server.mjs', 'src/network-access.json']) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), name === 'src/network-access.json' ? 'private-sentinel' : 'public-fixture');
  }
  const files = await copyPublicSourceSnapshot(root, stage, ['package.json', 'src/network/relay-server.mjs', 'src/network-access.json', 'scripts/removed-runtime.mjs']);
  assert.deepEqual(files, ['package.json', 'src/network/relay-server.mjs']);
  assert.equal(await readFile(join(stage, 'src/network/relay-server.mjs'), 'utf8'), 'public-fixture');
  await assert.rejects(readFile(join(stage, 'src/network-access.json')), { code: 'ENOENT' });
  await writeFile(join(directory, 'secret'), 'private-sentinel');
  await symlink(join(directory, 'secret'), join(root, 'src/leak.mjs'));
  await assert.rejects(copyPublicSourceSnapshot(root, stage, ['src/leak.mjs']), /symlink refused/);
  await mkdir(join(directory, 'private-directory'));
  await writeFile(join(directory, 'private-directory/leak.mjs'), 'private-sentinel');
  await symlink(join(directory, 'private-directory'), join(root, 'src/parent'));
  await assert.rejects(copyPublicSourceSnapshot(root, stage, ['src/parent/leak.mjs']), /symlink refused/);
});
