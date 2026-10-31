import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { validatePublicArtifact } from '../src/release/public-artifact.mjs';

const verified = { version: '0.3.1', filename: 'CodeLight-0.3.1-macos-arm64.zip', bytes: 1234, sha256: 'a'.repeat(64), notarization: 'Accepted', stapled: true, gatekeeperAccepted: true };
test('public distribution rejects unverified binaries, filename traversal and mismatched release identity', () => {
  assert.deepEqual(validatePublicArtifact(verified), verified);
  for (const change of [{ notarization: 'Invalid' }, { stapled: false }, { gatekeeperAccepted: false }, { filename: '../account.json' }, { filename: 'https://foreign.example/asset.zip' }, { filename: 'CodeLight-0.3.0-macos-arm64.zip' }, { sha256: '<script>' }, { bytes: 0 }, { bytes: Infinity }, { sourceCommit: 'private-path' }, { token: 'private-credential' }, { deviceId: 'private-device' }]) assert.throws(() => validatePublicArtifact({ ...verified, ...change }), /Invalid verified/);
});
test('website keeps unique anchor identities and loads only local script, styles and images', async () => {
  const window = new Window({ url: 'https://fixture.example/', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } }); window.document.write(await readFile(new URL('../website/index.html', import.meta.url), 'utf8'));
  const ids = [...window.document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const node of window.document.querySelectorAll('script[src], link[rel="stylesheet"][href], img[src]')) {
    const value = node.getAttribute('src') ?? node.getAttribute('href'); assert.ok(value && !/^(https?:)?\/\//u.test(value));
  }
  for (const anchor of window.document.querySelectorAll('a[href^="#"]')) { const id = anchor.getAttribute('href')?.slice(1); if (id) assert.ok(window.document.getElementById(id), id); }
  const headers = await readFile(new URL('../deploy/website/security-headers.conf', import.meta.url), 'utf8');
  assert.match(headers, /frame-ancestors 'none'/u); assert.doesNotMatch(headers, /unsafe-inline|unsafe-eval/u);
  await window.happyDOM.close();
});
