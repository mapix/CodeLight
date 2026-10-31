import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyCodeLightSource, forbiddenSourcePath } from '../src/delivery/package-source.mjs';

const run = promisify(execFile);

test('source packaging excludes private state, old mobile UI and dependency/build trees', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-package-test-')), input = join(directory, 'input'), output = join(directory, 'output');
  const write = async (/** @type {string} */ name, /** @type {string} */ value = 'fixture') => { const path = join(input, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, value); };
  try {
    for (const name of ['src/main.mjs', 'native/bin/macos-ax-control', 'package.json', 'spec/codelight-product.md', 'spec/happy-based-solution.md', 'clients/happy/LICENSE', 'clients/happy/packages/happy-app/sources/App.tsx']) await write(name);
    for (const name of ['evidence/private/account.json', 'data/history.sqlite', 'mobile/App.tsx', 'research/extracted.js', 'src/private/account.json', 'src/.env', 'src/key.pem', 'src/WORKLOG-CODELIGHT.md', 'native/.module-cache/cache', 'native/codelight-native-worker-qa/Tests/CodeLightWorkerTests.swift', 'native/codelight-qa/Tests/Tests.swift', 'scripts/package.mjs', 'spec/delivery.md', 'spec/native-mobile-app.md', 'spec/native-mobile-transport.md', 'clients/happy/node_modules/key.js', 'clients/happy/packages/happy-app/ios/Pods/a.m', 'clients/happy/packages/happy-app/ios/build/user.json', 'clients/happy/packages/happy-app/server.env']) await write(name, 'private-sentinel');
    const result = await copyCodeLightSource(input, output, { happyFiles: ['LICENSE', 'packages/happy-app/sources/App.tsx', 'packages/happy-app/server.env'] });
    assert.ok(result.files.includes('src/main.mjs')); assert.ok(result.files.includes('native/bin/macos-ax-control'));
    assert.ok(result.files.includes('spec/codelight-product.md')); assert.ok(result.files.includes('spec/happy-based-solution.md'));
    for (const name of ['spec/delivery.md', 'spec/native-mobile-app.md', 'spec/native-mobile-transport.md']) {
      assert.ok(!result.files.includes(name)); assert.equal(await readFile(join(input, name), 'utf8'), 'private-sentinel');
      assert.ok(forbiddenSourcePath(`CodeLight/${name}`));
    }
    assert.ok(result.files.includes('clients/happy/LICENSE')); assert.ok(result.files.includes('clients/happy/packages/happy-app/sources/App.tsx'));
    assert.ok(!result.files.some(forbiddenSourcePath));
    for (const name of result.files) assert.ok(!(await readFile(join(output, name), 'utf8')).includes('private-sentinel'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('source packaging refuses a symlink that could leak external user content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-package-link-')), input = join(directory, 'input');
  try { await mkdir(join(input, 'src'), { recursive: true }); await writeFile(join(directory, 'secret'), 'private'); await symlink(join(directory, 'secret'), join(input, 'src', 'leak'));
    await assert.rejects(copyCodeLightSource(input, join(directory, 'output')), /symlink refused/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('source packaging prunes only unavailable Happy environment commands in staging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-package-metadata-')), input = join(directory, 'input'), output = join(directory, 'output');
  const product = { name: 'happy-fixture', scripts: { 'env:new': 'missing new', 'env:up': 'missing up', 'env:up:authenticated': 'pnpm env:up', web: 'pnpm app web', postinstall: 'node scripts/postinstall.cjs', environment: 'node present.mjs' },
    dependencies: { retained: '1.2.3' }, devDependencies: { retainedDev: '4.5.6' }, workspaces: { packages: ['packages/happy-app'] }, pnpm: { overrides: { retained: '1.2.3' } }, packageManager: 'pnpm@10.11.0' };
  const bytes = `${JSON.stringify(product, null, 4)}\n`, lock = 'lockfileVersion: 9.0\nretained: unchanged\n';
  try {
    await mkdir(join(input, 'clients/happy'), { recursive: true }); await writeFile(join(input, 'clients/happy/package.json'), bytes); await writeFile(join(input, 'clients/happy/pnpm-lock.yaml'), lock);
    const result = await copyCodeLightSource(input, output);
    const staged = JSON.parse(await readFile(join(output, 'clients/happy/package.json'), 'utf8'));
    const expected = structuredClone(product); for (const key of ['env:new', 'env:up', 'env:up:authenticated']) delete expected.scripts[/** @type {keyof typeof expected.scripts} */ (key)];
    assert.deepEqual(staged, expected); assert.deepEqual(result.transformations, [{ file: 'clients/happy/package.json', removedScripts: ['env:new', 'env:up', 'env:up:authenticated'] }]);
    assert.equal(await readFile(join(input, 'clients/happy/package.json'), 'utf8'), bytes); assert.equal(await readFile(join(output, 'clients/happy/pnpm-lock.yaml'), 'utf8'), lock);
    const repacked = join(directory, 'repacked'), next = await copyCodeLightSource(output, repacked);
    assert.deepEqual(next.transformations, []); assert.equal(await readFile(join(repacked, 'clients/happy/package.json'), 'utf8'), await readFile(join(output, 'clients/happy/package.json'), 'utf8'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('standalone source ZIP omits tracked deletions and records the actual current file selection', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-package-archive-')), input = join(directory, 'input'), extracted = join(directory, 'extracted');
  try {
    await mkdir(join(input, 'scripts'), { recursive: true }); await mkdir(join(input, 'src/release'), { recursive: true }); await mkdir(extracted);
    await writeFile(join(input, 'package.json'), JSON.stringify({ name: 'codelight', version: '0.4.0' }));
    await writeFile(join(input, 'scripts/removed-runtime.mjs'), 'deleted fixture');
    await writeFile(join(input, '.gitignore'), 'deliverables/\n');
    for (const path of ['scripts/package-codelight.mjs', 'src/release/source-snapshot.mjs']) await writeFile(join(input, path), await readFile(new URL(`../${path}`, import.meta.url)));
    await run('git', ['init', '-q'], { cwd: input }); await run('git', ['add', '--all'], { cwd: input });
    await rm(join(input, 'scripts/removed-runtime.mjs'));
    await run(process.execPath, [join(input, 'scripts/package-codelight.mjs')]);
    await run('ditto', ['-x', '-k', join(input, 'deliverables/CodeLight-Source.zip'), extracted]);
    const manifest = JSON.parse(await readFile(join(input, 'deliverables/source-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files, ['.gitignore', 'package.json', 'scripts/package-codelight.mjs', 'src/release/source-snapshot.mjs']);
    assert.equal(manifest.sourceFiles, manifest.files.length); assert.equal(manifest.privateStateExcluded, true);
    await assert.rejects(readFile(join(extracted, 'codelight/scripts/removed-runtime.mjs')), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(join(extracted, 'codelight/package.json'), 'utf8')), { name: 'codelight', version: '0.4.0' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
