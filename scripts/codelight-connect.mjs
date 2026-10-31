import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { CodexBackend } from '../src/adapters/codex-backend.mjs';
import { HappySessionTransport } from '../src/happy/session-transport.mjs';
import { NativeHappyConnector } from '../src/happy/native-connector.mjs';
import { CommandReceipts } from '../src/commands.mjs';
import { SourceRegistry } from '../src/happy/source-registry.mjs';
import { machinePresence } from '../src/happy/machine-presence.mjs';

const lockfile = createRequire(import.meta.url)('proper-lockfile');
const flags = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return at < 0 ? [arg, '1'] : [arg.slice(0, at), arg.slice(at + 1)]; }));
const accountPath = flags.get('--account'), bindingPath = flags.get('--binding');
if (!accountPath || !bindingPath) throw Error('Usage: node scripts/codelight-connect.mjs --account=/private/account.json --binding=/private/source-binding.json');
const account = JSON.parse(await readFile(resolve(accountPath), 'utf8'));
const binding = JSON.parse(await readFile(resolve(bindingPath), 'utf8'));
if (binding.source?.app !== 'codex' || binding.source.hostId !== 'local') throw Error('This launcher binds only a verified local Codex source.');
const stateDir = resolve(flags.get('--state-dir') ?? join(dirname(resolve(bindingPath)), 'connector'));
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const nativeId = binding.source.id;
const scope = createHash('sha256').update(`codex:local:${nativeId}`).digest('hex');
const marker = join(stateDir, `${scope}.source`);
await writeFile(marker, '', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
let ownsLease = true;
const releaseLease = await lockfile.lock(marker, { realpath: false, stale: 10000, update: 2000, retries: 0,
    onCompromised: () => { ownsLease = false; } });
const backend = new CodexBackend();
const machine = await new SourceRegistry({ directory: dirname(resolve(bindingPath)), account }).machine();
if (binding.metadata.machineId !== machine.id) throw Error('The source binding belongs to another connector machine.');
const presence = machinePresence({ serverUrl: account.serverUrl, token: account.token, machineId: machine.id });
const key = new Uint8Array(Buffer.from(binding.sessionKey, 'base64'));
const transport = new HappySessionTransport({ serverOrigin: account.serverUrl, token: account.token,
    sessionId: binding.happySessionId, encryptionKey: key, statePath: join(stateDir, `${scope}-transport.json`), initialMetadata: binding.metadata });
const generation = () => {
    // 原 IPC 订阅拥有 owner cache，并在断开/owner 退出时清空；不为每个流 chunk 重做 discovery。
    const owner = backend.ipc.owners.get(nativeId);
    return owner ? `${owner.hostId}:${owner.ownerClientId}` : null;
};
const connector = new NativeHappyConnector({ transport, adapter: backend, nativeId, sourceIdentity: binding.source,
    bindingId: `codelight:${binding.happySessionId}`, metadata: binding.metadata, encryptionKey: key,
    statePath: join(stateDir, `${scope}-projection.json`), receipts: await CommandReceipts.load(join(stateDir, `${scope}-receipts.json`)),
    getGeneration: generation, assertLease: () => ownsLease, supportsNativeProjection: true });
let closing = false;
async function close() {
    if (closing) return; closing = true; ownsLease = false;
    await connector.close(); await transport.close(); presence.close(); backend.dispose(); await releaseLease().catch(() => {});
}
process.once('SIGINT', () => { close().then(() => process.exit(0)); });
process.once('SIGTERM', () => { close().then(() => process.exit(0)); });
connector.on('diagnostic', value => console.log(JSON.stringify({ service: 'CodeLight', diagnostic: value.code })));
try {
    await connector.start();
    console.log(JSON.stringify({ service: 'CodeLight', nativeId, happySessionId: binding.happySessionId,
        ownerGeneration: await generation(), modelRunnerStarted: false, status: connector.status() }));
} catch (error) { await close(); throw error; }
