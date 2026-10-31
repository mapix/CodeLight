import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import nacl from 'tweetnacl';
import { PairingInvitations, createPairingGateway } from './pairing-gateway.mjs';
import { readOptionalPrivateJson, writeDurablePrivateJson } from './discovery-persistence.mjs';
import { CodeLightMacDaemon } from './mac-daemon.mjs';
import { LocalSourceDiscovery } from './discovery.mjs';
import { tunnelHealth } from './tunnel-health.mjs';
import { BundledCodexStorage } from './bundled-codex-storage.mjs';
import { DeviceRegistry } from './device-registry.mjs';
import { loadAPNsSender } from './apns-sender.mjs';
import { NotificationDispatcher } from './notification-dispatcher.mjs';
import { GatewayMetrics } from './gateway-metrics.mjs';
import { PublicAccessManager, EntryProbes } from '../network/public-access.mjs';

/** @typedef {Record<string,any>} Value */
const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const flags = new Map(process.argv.slice(2).map(value => { const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)]; }));
const state = resolve(flags.get('--state') ?? join(homedir(), 'Library/Application Support/CodeLight'));
const backendOrigin = 'http://127.0.0.1:57670';
const node = flags.get('--node') ?? join(runtime, 'node');
const backend = flags.get('--backend') ?? join(runtime, 'server/standalone.mjs');
const cloudflared = flags.get('--cloudflared') ?? join(runtime, 'cloudflared');
const lockfile = createRequire(import.meta.url)('proper-lockfile');
/** @type {Set<import('node:child_process').ChildProcess>} */ const children = new Set();
/** @type {CodeLightMacDaemon|null} */ let daemon = null;
/** @type {ReturnType<typeof createPairingGateway>|null} */ let gateway = null;
/** @type {NotificationDispatcher|null} */ let notifications = null;
/** @type {PairingInvitations|null} */ let invitations = null;
/** @type {(()=>Promise<void>)|null} */ let releaseLease = null;
/** @type {ReturnType<typeof setInterval>|null} */ let renewal = null;
let publicOrigin = '', closing = false;
/** @type {GatewayMetrics|null} */ let metrics = null;
/** @type {ReturnType<typeof setInterval>|null} */ let metricsTimer = null;
/** @type {PublicAccessManager|null} */ let access = null;
const entryProbes = new EntryProbes();
/** Local UI pipe only; invitations/tokens never enter a public status API or ordinary logs. @param {Value} value */
function notify(value) { process.stdout.write(JSON.stringify(value) + '\n'); }

async function close() {
  if (closing) return; closing = true;
  await notifications?.close();
  if (renewal) clearInterval(renewal);
  if (metricsTimer) clearInterval(metricsTimer);
  await access?.close();
  await daemon?.close();
  invitations?.close();
  gateway?.closeAllConnections();
  await new Promise(resolveClose => gateway ? gateway.close(resolveClose) : resolveClose(null));
  await metrics?.close();
  for (const child of children) child.kill('SIGTERM');
  await Promise.allSettled([...children].map(async child => {
    await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 5000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }));
  await releaseLease?.();
}
process.once('SIGTERM', () => { close().finally(() => process.exit(0)); });
process.once('SIGINT', () => { close().finally(() => process.exit(0)); });
process.once('uncaughtException', () => { notify({ type: 'error', code: 'service-failed' }); close().finally(() => process.exit(1)); });

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} env @param {string} logName */
async function child(command, args, env, logName) {
  const log = await open(join(state, logName), 'a', 0o600);
  const p = spawn(command, args, { cwd: join(runtime, 'server'), env, stdio: ['ignore', log.fd, log.fd] });
  children.add(p); p.once('exit', () => { children.delete(p); log.close().catch(() => {}); if (!closing) notify({ type: 'error', code: 'owned-process-exited' }); });
  p.once('error', () => { if (!closing) notify({ type: 'error', code: 'owned-process-failed' }); });
  return p;
}
/** @param {string} origin @param {number} timeout */
async function health(origin, timeout) {
  const deadline = Date.now() + timeout;
  do {
    try { if (await tunnelHealth(origin)) return; } catch { /* startup/reconnect remains explicitly pending */ }
    await new Promise(r => setTimeout(r, 300));
  } while (!closing && Date.now() < deadline);
  throw Error('service-health-unavailable');
}
async function owner() {
  const path = join(state, 'connector/account.json');
  let saved = await readOptionalPrivateJson(path);
  if (!saved) { saved = { version: 1, serverUrl: backendOrigin, secret: randomBytes(32).toString('base64url') }; await writeDurablePrivateJson(path, saved); }
  if (saved.serverUrl !== backendOrigin) throw Error('owner-origin-mismatch');
  const seed = Buffer.from(saved.secret, 'base64url'); if (seed.length !== 32) throw Error('owner-key-invalid');
  const pair = nacl.sign.keyPair.fromSeed(seed), challenge = randomBytes(32);
  const response = await fetch(backendOrigin + '/v1/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: Buffer.from(pair.publicKey).toString('base64'), challenge: challenge.toString('base64'), signature: Buffer.from(nacl.sign.detached(challenge, pair.secretKey)).toString('base64') }) });
  const reply = /** @type {Value} */ (await response.json());
  if (!response.ok || reply.success !== true || typeof reply.token !== 'string') throw Error('owner-authentication-failed');
  pair.secretKey.fill(0); saved.token = reply.token; await writeDurablePrivateJson(path, saved); return saved;
}
function issue() {
  if (!invitations || !publicOrigin || closing) return;
  const grant = invitations.issue(publicOrigin); notify({ type: 'ready', origin: publicOrigin, pairingUrl: grant.url, expires: grant.expires, temporary: true });
}
async function main() {
  await mkdir(state, { recursive: true, mode: 0o700 }); await mkdir(join(state, 'connector'), { recursive: true, mode: 0o700 });
  const marker = join(state, 'service.source'); const file = await open(marker, 'a', 0o600); await file.close();
  releaseLease = await lockfile.lock(marker, { realpath: false, stale: 10000, update: 2000, retries: 0 });
  let relay = await readOptionalPrivateJson(join(state, 'relay-key.json'));
  if (!relay) { relay = { secret: randomBytes(32).toString('hex') }; await writeDurablePrivateJson(join(state, 'relay-key.json'), relay); }
  const env = /** @type {NodeJS.ProcessEnv} */ ({ ...process.env, HANDY_MASTER_SECRET: relay.secret, PORT: '57670', HOST: '127.0.0.1',
    DATA_DIR: join(state, 'relay'), PGLITE_DIR: join(state, 'relay/pglite'), DB_PROVIDER: 'pglite', NODE_ENV: 'production', HAPPY_DISABLE_ANALYTICS: '1' });
  for (const key of ['DATABASE_URL', 'REDIS_URL', 'S3_HOST', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']) delete env[key];
  // 固定 loopback identity 属于同一份本地数据库；公网临时地址变化不能改写原 command/receipt 的身份。
  notify({ type: 'starting', phase: 'local-service' });
  const migrationLog = await open(join(state, 'migration.log'), 'a', 0o600);
  const migration = spawn(node, [backend, 'migrate'], { cwd: join(runtime, 'server'), env, stdio: ['ignore', 'ignore', migrationLog.fd] });
  children.add(migration); const [code] = await once(migration, 'exit'); children.delete(migration); await migrationLog.close();
  if (code !== 0) throw Error('local-migration-failed');
  await child(node, [backend, 'serve'], env, 'relay.log'); await health(backendOrigin, 30000);
  const account = await owner();
  const devices = await DeviceRegistry.load(join(state, 'devices.json'));
  devices.on('changed', rows => notify({ type: 'devices', devices: rows }));
  notify({ type: 'devices', devices: devices.list() });
  let key = await readOptionalPrivateJson(join(state, 'mac-box-key.json'));
  if (!key) { key = { secret: randomBytes(32).toString('base64url') }; await writeDurablePrivateJson(join(state, 'mac-box-key.json'), key); }
  invitations = new PairingInvitations({ key: new Uint8Array(Buffer.from(key.secret, 'base64url')), credentials: account,
    issueCredentials: async (publicKey, name, issuedAt) => {
      const encodedKey = Buffer.from(publicKey, 'base64url').toString('base64');
      const post = async (/** @type {string} */ path, /** @type {Value} */ body, authenticated = false) => {
        const response = await fetch(backendOrigin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + account.token } : {}) }, body: JSON.stringify(body) });
        if (!response.ok) throw Error('device-token-issuance-failed'); return /** @type {Value} */ (await response.json());
      };
      await post('/v1/auth/request', { publicKey: encodedKey, supportsV2: false });
      const ephemeral = nacl.box.keyPair(), nonce = randomBytes(24), cipher = nacl.box(Buffer.from(account.secret, 'base64url'), nonce, Buffer.from(publicKey, 'base64url'), ephemeral.secretKey);
      const sealed = Buffer.concat([Buffer.from(ephemeral.publicKey), nonce, Buffer.from(cipher)]).toString('base64'); ephemeral.secretKey.fill(0);
      await post('/v1/auth/response', { publicKey: encodedKey, response: sealed }, true);
      const reply = await post('/v1/auth/request', { publicKey: encodedKey, supportsV2: false });
      if (reply.state !== 'authorized' || typeof reply.token !== 'string') throw Error('device-token-issuance-failed');
      const deviceId = await devices.approve(publicKey, name, reply.token, issuedAt);
      return { token: reply.token, secret: account.secret, deviceId };
    } });
  let sender = null;
  try { sender = await loadAPNsSender(join(state, 'apns.json')); } catch { notify({ type: 'diagnostic', code: 'apns-configuration-unavailable' }); }
  notify({ type: 'notifications', available: !!sender });
  notifications = new NotificationDispatcher({ path: join(state, 'notifications.json'), devices, sender, origin: () => publicOrigin, onDiagnostic: code => notify({ type: 'diagnostic', code }) });
  await notifications.start();
  try { metrics = await GatewayMetrics.load(join(state, 'gateway-metrics.json')); }
  // 累计文件读取失败时只继续统计本次流量；旧累计值未知，不能伪装成零或覆盖原文件。
  catch { notify({ type: 'diagnostic', code: 'gateway-metrics-unavailable' }); metrics = new GatewayMetrics({ cumulativeKnown: false }); }
  gateway = createPairingGateway({ upstream: backendOrigin, invitations, devices, metrics, notificationsAvailable: !!sender, entryProbe: challenge => entryProbes.response(challenge) }); gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const publishMetrics = () => { if (!closing && metrics) notify({ type: 'metrics', metrics: metrics.snapshot({ connectedDevices: devices.list().filter(device => !device.revoked && device.connected).length }) }); };
  publishMetrics(); metricsTimer = setInterval(publishMetrics, 1000);
  const address = gateway.address(); if (!address || typeof address === 'string') throw Error('gateway-address-unavailable');
  daemon = new CodeLightMacDaemon({ directory: join(state, 'connector'), leaseDirectory: join(homedir(), '.codelight/leases'), account,
    onRpc: () => metrics?.rpc(), viewedSessions: () => devices.viewedSessions(), discovery: new LocalSourceDiscovery({ storage: new BundledCodexStorage() }), only: source => source.app === 'codex' });
  daemon.on('diagnostic', value => notify({ type: 'diagnostic', code: value.code }));
  daemon.on('notification-observation', value => notifications?.observe(value.sourceKey, value.sessionId, value.summary).catch(() => notify({ type: 'diagnostic', code: 'notification-observation-pending' })));
  await daemon.start();
  notify({ type: 'starting', phase: 'public-connection' });
  access = new PublicAccessManager({ state, upstream: `http://127.0.0.1:${address.port}`, cloudflared, probes: entryProbes });
  access.on('ready', (/** @type {Value} */ value) => { publicOrigin = value.origin; issue(); });
  access.on('configuration', (/** @type {Value} */ value) => notify({ type: 'access-configuration', configuration: value }));
  access.on('status', (/** @type {Value} */ value) => notify({ type: 'access-status', ...value }));
  renewal = setInterval(issue, 90000);
  createInterface({ input: process.stdin }).on('line', value => {
    try {
      const command = JSON.parse(value);
      if (command.type === 'refresh-invite') issue();
      else if (command.type === 'rename-device' && typeof command.id === 'string' && typeof command.name === 'string') devices.rename(command.id, command.name).catch(() => notify({ type: 'diagnostic', code: 'device-operation-failed' }));
      else if (command.type === 'revoke-device' && typeof command.id === 'string') devices.revoke(command.id).then(issue).catch(() => notify({ type: 'diagnostic', code: 'device-operation-failed' }));
      else if (command.type === 'configure-access' && typeof command.requestId === 'string' && command.requestId.length <= 128) {
        const requestId = command.requestId;
        Promise.resolve().then(() => access?.apply({ mode: command.mode, serverUrl: command.serverUrl, ...(typeof command.token === 'string' ? { token: command.token } : {}) }))
          .then(() => notify({ type: 'access-result', requestId, ok: true }))
          .catch(() => notify({ type: 'access-result', requestId, ok: false, code: 'public-access-validation-failed' }));
      }
    } catch { /* The local UI pipe accepts only the explicit operations above. */ }
  });
  // 公网配置失败只影响入口，服务与配置管道仍可用；不能把用户锁死在坏地址后的重启循环中。
  access.load().catch(() => notify({ type: 'access-status', state: 'unavailable', code: 'public-access-validation-failed' }));
}
main().catch(async error => { notify({ type: 'error', code: error instanceof Error ? error.message : 'service-start-failed' }); await close(); process.exit(1); });
