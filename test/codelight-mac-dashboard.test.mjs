import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);

test('Mac dashboard pure values preserve measured zero, missing values, byte units and panel choice', { skip: process.platform !== 'darwin' }, async () => {
  const source = await readFile(new URL('../apps/mac/CodeLight.swift', import.meta.url), 'utf8');
  const declarations = source.split('// BEGIN CODELIGHT DASHBOARD VALUES\n')[1]?.split('// END CODELIGHT DASHBOARD VALUES')[0];
  assert.ok(declarations);
  const directory = await mkdtemp(join(tmpdir(), 'codelight-mac-values-'));
  try {
    const script = join(directory, 'values.swift');
    await writeFile(script, 'import Foundation\n' + declarations + String.raw`
func decoded(_ text: String) throws -> DashboardMetrics { try JSONDecoder().decode(DashboardMetrics.self, from: Data(text.utf8)) }
let english = Locale(identifier: "en_US"), german = Locale(identifier: "de_DE")
let complete = try decoded(#"{"version":1,"receivedBytes":2048,"sentBytes":4096,"totalReceivedBytes":1048576,"totalSentBytes":2097152,"receiveBytesPerSecond":1024,"sendBytesPerSecond":1536,"httpRequests":12,"rpcRequests":7,"connectedDevices":2,"uptimeMs":1000}"#)
precondition(complete.receivedBytes == 2048 && complete.totalReceivedBytes == 1048576 && complete.hasMeasurements)
precondition(complete.httpRequests == 12 && complete.rpcRequests == 7 && complete.connectedDevices == 2)
precondition(DashboardFormat.bytes(complete.receiveBytesPerSecond, perSecond: true, locale: english) == "1 KiB/s")
precondition(DashboardFormat.bytes(complete.totalReceivedBytes, locale: english) == "1 MiB")
precondition(DashboardFormat.bytes(complete.sendBytesPerSecond, perSecond: true, locale: german) == "1,5 KiB/s")
precondition(DashboardFormat.count(1234, locale: english) == "1,234")
precondition(DashboardFormat.bytes(Double(Int64.max) * 2, locale: english).contains("EiB"))
let partial = try decoded(#"{"version":1,"receivedBytes":0,"sentBytes":true,"receiveBytesPerSecond":0,"sendBytesPerSecond":-1,"httpRequests":0.5,"rpcRequests":"invalid","connectedDevices":null}"#)
precondition(partial.receivedBytes == 0 && partial.receiveBytesPerSecond == 0)
precondition(partial.sentBytes == nil && partial.httpRequests == nil && partial.rpcRequests == nil && partial.connectedDevices == nil && partial.sendBytesPerSecond == nil)
precondition(DashboardFormat.bytes(partial.receivedBytes, locale: english) == "0 B")
precondition(DashboardFormat.bytes(partial.receiveBytesPerSecond, perSecond: true, locale: english) == "0 B/s")
precondition(DashboardFormat.count(partial.rpcRequests) == "—")
let absent = try decoded("{}")
precondition(!absent.hasMeasurements && absent.receivedBytes == nil && DashboardFormat.bytes(absent.receivedBytes) == "—")
precondition(DashboardFormat.uptime(nil) == "—" && DashboardFormat.uptime(-1) == "—")
precondition(DashboardFormat.uptime(complete.uptimeMs).contains("1"))
var refused = false
do { _ = try decoded(#"{"version":2,"receivedBytes":10}"#) } catch { refused = true }
precondition(refused)
var selection = DashboardSelection()
precondition(selection.panel == .pairing)
selection.receivePairedDevices(false); precondition(selection.panel == .pairing)
selection.receivePairedDevices(true); precondition(selection.panel == .statistics)
selection.select(.pairing); selection.receivePairedDevices(true); precondition(selection.panel == .pairing)
var manual = DashboardSelection()
manual.select(.pairing); manual.receivePairedDevices(true); precondition(manual.panel == .pairing)
print("mac-dashboard-values-passed")
`);
    const sdk = await execute('/usr/bin/xcrun', ['--show-sdk-path']);
    const result = await execute('/usr/bin/xcrun', ['swift', '-sdk', sdk.stdout.trim(), script], { timeout: 30000 });
    assert.match(result.stdout, /mac-dashboard-values-passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Mac dashboard current Chinese locale explicitly translates the gateway requirement and metrics labels', async () => {
  const source = await readFile(new URL('../scripts/build-mac-app.mjs', import.meta.url), 'utf8');
  const dictionary = source.split('const chinese = ')[1]?.split('\n};')[0]; assert.ok(dictionary);
  const translations = new Map([...dictionary.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)].map(match => [match[1], match[2]]));
  assert.equal(translations.get('Only desktop Codex connected through gateway mode is supported.'), '只支持使用网关模式接入的桌面Codex');
  for (const key of ['Connection ready', 'View', 'Statistics', 'Pairing', 'Gateway traffic', 'Receiving', 'Sending', 'This connection', 'All time', 'Received', 'Sent',
    'HTTP requests', 'RPC calls', 'Connected devices', 'Uptime', 'Waiting for gateway measurements…', 'Gateway traffic measured by CodeLight. — means not measured.', '/s']) {
    assert.ok(translations.get(key)?.trim(), key);
  }
  for (const key of ['Retry', 'Disconnect', 'Copy pairing link', 'Refresh QR', 'Could not update device. Try again.']) assert.ok(translations.get(key)?.trim(), key);
});
