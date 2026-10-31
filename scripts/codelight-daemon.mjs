import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { pairCodeLight, normalizeServerOrigin } from '../src/happy/discovery-pairing.mjs';
import { readOptionalPrivateJson, writeDurablePrivateJson } from '../src/happy/discovery-persistence.mjs';
import { LocalSourceDiscovery } from '../src/happy/discovery.mjs';
import { CodeLightMacDaemon } from '../src/happy/mac-daemon.mjs';

const flags = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return at < 0 ? [arg, '1'] : [arg.slice(0, at), arg.slice(at + 1)]; }));
const allowed = new Set(['--help', '--inspect', '--server', '--profile', '--account-file', '--lease-dir', '--only']);
for (const [key, value] of flags) {
  if (!allowed.has(key)) throw Error(`Unknown CodeLight option: ${key}. Use --help.`);
  if (!['--help', '--inspect'].includes(key) && (!value.trim() || value === '1')) throw Error(`${key} requires an explicit value using ${key}=value.`);
}
const selected = flags.get('--only');
// scope 在任何 profile 读取、配对或写入之前校验，避免拒绝的 harness 留下配对状态。
if (selected !== undefined && !/^codex:[^\s]+$/.test(selected)) throw Error('Only native Codex session scope is supported (--only=codex:native-id).');
if (flags.has('--help')) {
  console.log('CodeLight Mac: node scripts/codelight-daemon.mjs --server=https://your-server [--profile=/private/profile] [--only=codex:native-id] [--inspect]');
  process.exit(0);
}
if (flags.has('--inspect')) {
  const inspector = new LocalSourceDiscovery();
  try { const result = await inspector.discover(); console.log(JSON.stringify({ discoveredSources: result.sources.map(source => ({ app: source.app, id: source.id, kind: source.kind, available: source.available ?? null })), errors: result.errors })); }
  finally { await inspector.close(); }
  process.exit(0);
}
const directory = resolve(flags.get('--profile') ?? join(homedir(), '.codelight'));
const configuration = await readOptionalPrivateJson(join(directory, 'config.json'));
const provided = flags.get('--server') ?? configuration?.serverUrl;
if (!provided) throw Error('First startup requires --server=https://your-self-hosted-server. CodeLight does not fall back to a public service.');
const serverUrl = normalizeServerOrigin(provided);
const accountPath = join(directory, 'account.json');
const lockfile = createRequire(import.meta.url)('proper-lockfile');
await mkdir(directory, { recursive: true, mode: 0o700 });
const initializationMarker = join(directory, 'initialize.source');
await writeFile(initializationMarker, '', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
const releaseInitialization = await lockfile.lock(initializationMarker, { realpath: false, stale: 10000, update: 2000, retries: 0 });
if (await lockfile.check(join(directory, 'daemon.source'), { realpath: false }).catch(() => false)) {
  await releaseInitialization(); throw Error('CodeLight is already running for this profile. Reuse its pairing and source connections.');
}
const cancellation = new AbortController();
const signalAbort = () => cancellation.abort(Error('CodeLight was stopped.'));
process.once('SIGINT', signalAbort); process.once('SIGTERM', signalAbort);
let account;
const accountFile = flags.get('--account-file');
try {
if (accountFile) {
  account = await readOptionalPrivateJson(resolve(accountFile));
  if (!account || normalizeServerOrigin(account.serverUrl) !== serverUrl || Buffer.from(account.secret ?? '', 'base64url').length !== 32) throw Error('The explicitly supplied CodeLight account does not match this server.');
  const priorAccount = await readOptionalPrivateJson(accountPath);
  if (priorAccount && (priorAccount.serverUrl !== serverUrl || !Buffer.from(priorAccount.secret ?? '', 'base64url').equals(Buffer.from(account.secret, 'base64url')))) throw Error('This profile is already paired to another account. Use a separate --profile.');
  await writeDurablePrivateJson(accountPath, account);
} else account = await pairCodeLight({ serverUrl, accountPath, signal: cancellation.signal, onLink: link => {
  console.log('Open CodeLight on your phone, select this server, then scan or paste this pairing link:');
  console.log(serverUrl); console.log(link);
  try {
    const require = createRequire(import.meta.url);
    require('qrcode-terminal').generate(link, { small: true }, (/** @type {string} */ code) => console.log(code));
  } catch { /* The complete public pairing link remains usable without the optional QR renderer. */ }
} });
await writeDurablePrivateJson(join(directory, 'config.json'), { version: 1, serverUrl });
} finally { await releaseInitialization(); }
const discovery = new LocalSourceDiscovery();
const daemon = new CodeLightMacDaemon({ directory, leaseDirectory: resolve(flags.get('--lease-dir') ?? join(homedir(), '.codelight', 'leases')),
  account, discovery, only: selected ? source => `${source.app}:${source.id}` === selected : undefined });
daemon.on('diagnostic', value => console.log(JSON.stringify({ service: 'CodeLight', diagnostic: value.code })));
let closing = false;
const close = async () => { if (closing) return; closing = true; await daemon.close(); };
process.removeListener('SIGINT', signalAbort); process.removeListener('SIGTERM', signalAbort);
process.once('SIGINT', () => { close().then(() => process.exit(0)); });
process.once('SIGTERM', () => { close().then(() => process.exit(0)); });
try { console.log(JSON.stringify({ ...(await daemon.start()), sourceRoot: fileURLToPath(new URL('..', import.meta.url)) })); }
catch (error) { await close(); throw error; }
