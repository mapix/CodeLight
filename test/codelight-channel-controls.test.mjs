import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const execute = promisify(execFile);

test('Mac channel values expose Relay only when configured and distinguish readiness from unavailable or unverified', { skip: process.platform !== 'darwin' }, async () => {
  const source = await readFile(new URL('../apps/mac/CodeLight.swift', import.meta.url), 'utf8');
  const declarations = source.split('// BEGIN CODELIGHT CONNECTION VALUES\n')[1]?.split('// END CODELIGHT CONNECTION VALUES')[0]; assert.ok(declarations);
  const directory = await mkdtemp(join(tmpdir(), 'codelight-mac-channel-values-'));
  try {
    const script = join(directory, 'values.swift');
    await writeFile(script, 'import Foundation\n' + declarations + String.raw`
let decoder = JSONDecoder()
let initial = try decoder.decode(ConnectionConfiguration.self, from: Data(#"{"enabledChannels":["local","cloudflare"],"relayConfigured":false,"serverUrl":"","hasToken":false}"#.utf8))
precondition(initial.availableKinds == ["local", "cloudflare"])
precondition(initial.enabledKinds == Set(["local", "cloudflare"]))
let configured = try decoder.decode(ConnectionConfiguration.self, from: Data(#"{"enabledChannels":["local","relay"],"relayConfigured":true,"serverUrl":"https://relay.example","hasToken":true}"#.utf8))
precondition(configured.availableKinds == ["local", "cloudflare", "relay"])
precondition(configured.enabledKinds == Set(["local", "relay"]))
let channels = try decoder.decode([ConnectionChannel].self, from: Data(#"[{"id":"lan-one","kind":"local","url":"http://192.168.50.2:8080","state":"ready"},{"id":"cloudflare","kind":"cloudflare","url":"https://public.example","state":"unverified"},{"id":"relay","kind":"relay","url":"","state":"unavailable"}]"#.utf8))
precondition(ConnectionStatus.label(kind: "local", configuration: initial, channels: channels) == "Ready")
precondition(ConnectionStatus.label(kind: "cloudflare", configuration: initial, channels: channels) == "Not verified yet")
precondition(ConnectionStatus.label(kind: "relay", configuration: configured, channels: channels) == "Unavailable")
precondition(ConnectionStatus.label(kind: "cloudflare", configuration: configured, channels: channels) == "Off")
precondition(channels[0].displayLabel == "Local network")
print("mac-channel-values-passed")
`);
    const sdk = await execute('/usr/bin/xcrun', ['--show-sdk-path']);
    const result = await execute('/usr/bin/xcrun', ['swift', '-sdk', sdk.stdout.trim(), script], { timeout: 30000 }); assert.match(result.stdout, /mac-channel-values-passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
