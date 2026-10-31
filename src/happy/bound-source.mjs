import { mkdir, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeHappyConnector } from './native-connector.mjs';
import { HappySessionTransport } from './session-transport.mjs';
import { CommandReceipts } from '../commands.mjs';
import { sourceKey } from './source-registry.mjs';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
const lockfile = createRequire(import.meta.url)('proper-lockfile');

/** Wraps only screenshot files already produced by the bound native adapter. */
export class SourceImageAdapter {
  get supportsNativeModelSettings() { return this.adapter.supportsNativeModelSettings === true; }
  /** @param {Value} adapter @param {HappySessionTransport} transport */
  constructor(adapter, transport) { this.adapter = adapter; this.transport = transport; this.latest = /** @type {Value|null} */ (null); this.image = /** @type {{digest:string,ref:string}|null} */ (null); }
  /** @param {Value} frame */
  async transform(frame) {
    const raw = frame.native ?? frame;
    const view = raw.kind === 'window' ? { ...raw, bounds: raw.bounds ?? raw.captureStamp?.bounds ?? raw.physicalBounds ?? raw.logicalBounds } : raw;
    this.latest = view;
    if (view.kind !== 'window' || !view.imagePath || !view.captureStamp) return frame.native ? { ...frame, native: view } : view;
    const folder = await realpath(this.adapter.screenshotDir), path = await realpath(view.imagePath), rel = relative(folder, path);
    if (!rel || isAbsolute(rel) || rel.startsWith('..') || !/^window-[a-f0-9-]{36}\.png$/u.test(rel)) throw new BridgeError('invalid-window-image', 'The screenshot is outside this source adapter.');
    const size = (await stat(path)).size; if (size > 16 * 1024 * 1024) throw new BridgeError('image-too-large', 'The source screenshot exceeds its size bound.');
    const bytes = await readFile(path);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new BridgeError('invalid-window-image', 'The source screenshot is not a PNG.');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (this.image?.digest !== digest) { const result = await this.transport.uploadAttachment(bytes, { filename: 'desktop-window.png' }); this.image = { digest, ref: result.ref }; }
    const mapped = { ...view, imagePath: undefined, imageRef: this.image.ref, bounds: view.bounds ?? view.captureStamp.bounds ?? view.physicalBounds ?? view.logicalBounds };
    return frame.native ? { ...frame, native: mapped } : mapped;
  }
  /** @param {string} id */ async snapshot(id) { return this.transform(await this.adapter.snapshot(id)); }
  /** @param {string} id @param {(frame:Value)=>void} callback */
  async subscribe(id, callback) {
    let closed = false, running = false;
    /** @type {Value|null} */ let pending = null;
    const pump = async () => {
      if (running) return; running = true;
      try {
        while (pending && !closed) { const current = pending; pending = null;
          try { const mapped = await this.transform(current); if (!closed) callback(mapped); }
          catch { if (!closed) callback({ kind: 'window', status: 'disconnected', rows: [], controls: [], imageRef: null, captureStamp: null }); }
        }
      } finally { running = false; }
    };
    const release = await this.adapter.subscribe(id, (/** @type {Value} */ frame) => { pending = frame; pump().catch(() => {}); });
    return () => { closed = true; pending = null; release(); };
  }
  /** @param {string} id @param {string} action @param {Value} payload @param {string} commandId @param {Value} [context] */
  command(id, action, payload, commandId, context) { return this.adapter.command(id, action, payload, commandId, context); }
  /** @param {string} id */
  generation(id) {
    if (typeof this.adapter.generation === 'function') return this.adapter.generation(id);
    if (this.adapter.ipc) { const owner = this.adapter.ipc.owners.get(id); return owner ? `${owner.hostId}:${owner.ownerClientId}` : null; }
    const view = this.latest;
    return view?.captureStamp ? JSON.stringify([view.captureStamp.runtimeGeneration, view.captureStamp.windowGeneration]) : null;
  }
}

/** Factory never starts a model. A source lease is held before any explicit desktop navigation.
 * @param {{account:Value,binding:Value,directory:string,leaseDirectory:string,adapter:Value,assertHostLease?:()=>boolean}} options */
export async function createBoundSource(options) {
  const hash = sourceKey(options.binding.source); await mkdir(options.directory, { recursive: true, mode: 0o700 }); await mkdir(options.leaseDirectory, { recursive: true, mode: 0o700 });
  const marker = join(options.leaseDirectory, `${hash}.source`);
  await writeFile(marker, '', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  let ownsLease = true;
  const releaseLease = await lockfile.lock(marker, { realpath: false, stale: 10000, update: 2000, retries: 0, onCompromised: () => { ownsLease = false; } });
  let closed = false, retiring = false, activeOperations = 0;
  /** @type {Promise<void>|null} */ let closeFlight = null;
  /** @type {Promise<boolean>|null} */ let idleCloseFlight = null;
  const binding = options.binding, key = new Uint8Array(Buffer.from(binding.sessionKey, 'base64'));
  const transport = new HappySessionTransport({ serverOrigin: options.account.serverUrl, token: options.account.token, sessionId: binding.happySessionId,
    encryptionKey: key, statePath: join(options.directory, 'transport.json'), initialMetadata: binding.metadata });
  const adapter = new SourceImageAdapter(options.adapter, transport);
  let connector;
  try {
    connector = new NativeHappyConnector({ transport, adapter, nativeId: binding.source.id, sourceIdentity: binding.source, bindingId: `codelight:${binding.happySessionId}`,
      metadata: binding.metadata, encryptionKey: key, statePath: join(options.directory, 'projection.json'), receipts: await CommandReceipts.load(join(options.directory, 'receipts.json')),
      getGeneration: () => adapter.generation(binding.source.id), assertLease: () => ownsLease && !closed && (options.assertHostLease?.() ?? true), supportsNativeProjection: true });
  } catch (error) { await transport.close(); await releaseLease(); throw error; }
  const close = () => {
    if (!closeFlight) {
      closed = true; retiring = true; ownsLease = false;
      closeFlight = (async () => {
        try { await connector.close(); }
        finally {
          await transport.updateMetadata(current => {
            const value = /** @type {Value} */ (current ?? {});
            // 断开只关闭原生动作；回执是非侵入源的协议语义，不能让旧未确认消息变成“已接收”。
            return { ...value, bridge: { ...value.bridge, sourceStatus: 'disconnected' }, capabilities: { ...value.capabilities, abort: false, steering: false, messageReceipts: true, rpcMethods: [] } };
          }).catch(() => {});
          await transport.close(); await releaseLease().catch(() => {});
        }
      })();
    }
    return closeFlight;
  };
  return {
    transport, connector,
    /** @param {string} commandId */
    async openDesktop(commandId) {
      if (!ownsLease || closed || retiring || options.assertHostLease?.() === false) throw new BridgeError('source-lease-unavailable', 'This source lease is unavailable.');
      activeOperations++;
      try {
        if (binding.source.app === 'codex') return await options.adapter.command(binding.source.id, 'open-desktop', {}, commandId);
        const frame = await options.adapter.snapshot(binding.source.id);
        if (!ownsLease || closed || retiring || options.assertHostLease?.() === false) throw new BridgeError('source-lease-unavailable', 'This source lease is unavailable.');
        if (!frame.captureStamp) throw new BridgeError('source-unavailable', 'The original window is unavailable.');
        return await options.adapter.command(binding.source.id, 'activate', { captureStamp: frame.captureStamp, windowGeneration: frame.captureStamp.windowGeneration }, commandId);
      } finally { activeOperations--; }
    },
    start: () => closed || retiring ? Promise.reject(new BridgeError('source-unavailable', 'The CodeLight observer is closing.')) : connector.start(), status: () => connector.status(),
    /** @returns {Promise<boolean>} */
    tryCloseIfIdle() {
      if (closeFlight) return closeFlight.then(() => true);
      if (idleCloseFlight) return idleCloseFlight;
      retiring = true;
      if (activeOperations) { retiring = false; return Promise.resolve(false); }
      const flight = connector.tryCloseIfIdle().then(async retired => {
        if (!retired && !closed) { retiring = false; return false; }
        await close(); return true;
      }).finally(() => { if (idleCloseFlight === flight) idleCloseFlight = null; });
      idleCloseFlight = flight; return flight;
    },
    close,
  };
}
