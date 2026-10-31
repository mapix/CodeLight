import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SourceRegistry, sourceKey } from './source-registry.mjs';
import { CodeLightMachineConnection } from './machine-presence.mjs';
import { createBoundSource } from './bound-source.mjs';
import { CommandReceipts } from '../commands.mjs';
import { writeDurablePrivateJson, readOptionalPrivateJson } from './discovery-persistence.mjs';
import { BridgeError } from '../errors.mjs';
import { isCodeLightCodexSource } from './source-scope.mjs';
import { NativeProjectActivityService } from './project-activity.mjs';

/** @typedef {Record<string,any>} Value */
/** @typedef {{directory:string,leaseDirectory?:string,account:Value,discovery:{discover:()=>Promise<{sources:Value[],errors?:string[]}>,adapter:(source:Value)=>Value,close?:()=>Promise<void>|void},registry?:Value,machineConnection?:(options:Value)=>Value,sourceFactory?:(options:Value)=>Promise<Value>,activityFactory?:(options:Value)=>Value,onRpc?:(method:string)=>void,viewedSessions?:()=>Set<string>,scanMs?:number,only?:(source:Value)=>boolean,maxActiveSources?:number}} Options */
const lockfile = createRequire(import.meta.url)('proper-lockfile');

/** One process owns a profile; sources activate lazily and keep their original runtime owner. */
export class CodeLightMacDaemon extends EventEmitter {
  /** @type {Map<string,{source:Value,binding:Value}>} */ sources = new Map();
  /** @type {Map<string,Value>} */ actors = new Map();
  /** @type {Map<string,Promise<Value>>} */ activating = new Map();
  /** @type {Promise<Value>|null} */ scanFlight = null;
  /** @type {Value|null} */ machine = null;
  /** @type {Value|null} */ connection = null;
  /** @type {CommandReceipts|null} */ receipts = null;
  /** @type {(()=>Promise<void>)|null} */ releaseLease = null;
  /** @type {ReturnType<typeof setInterval>|null} */ timer = null;
  /** @type {Map<string,Promise<Value>>} */ preparing = new Map();
  /** @type {Map<string,Promise<void>>} */ starts = new Map();
  /** @type {Map<string,number>} */ latestSelection = new Map();
  activeSave = Promise.resolve();
  /** @type {Set<string>} */ restored = new Set();
  /** @type {Value|null} */ activity = null;
  inventoryAvailable = false;
  cacheReconciled = false;
  /** @type {Map<string,number>} */ sourceUses = new Map();
  /** @type {Map<string,number>} */ lastUsed = new Map();
  capacityTail = Promise.resolve();
  /** @param {Options} options */
  constructor(options) {
    super(); this.options = options; this.directory = resolve(options.directory); this.leaseDirectory = resolve(options.leaseDirectory ?? join(this.directory, 'leases'));
    this.registry = options.registry ?? new SourceRegistry({ directory: join(this.directory, 'sources'), account: options.account });
    this.sourceFactory = options.sourceFactory ?? createBoundSource;
    this.closed = false; this.ownsLease = false;
  }
  async start() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); const marker = join(this.directory, 'daemon.source');
    await writeFile(marker, '', { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    this.releaseLease = await lockfile.lock(marker, { realpath: false, stale: 10000, update: 2000, retries: 0, onCompromised: () => { this.ownsLease = false; this.emit('diagnostic', { code: 'daemon-lease-lost' }); } }); this.ownsLease = true;
    try {
      this.receipts = await CommandReceipts.load(join(this.directory, 'machine-receipts.json'));
      this.machine = await this.registry.machine();
      this.activity = (this.options.activityFactory ?? (options => new NativeProjectActivityService(/** @type {any} */ (options))))({
        sources: () => [...this.sources.values()].map(({ source, binding }) => ({ ...source, relayId: binding.happySessionId, controlMode: binding.metadata?.bridge?.controlMode,
          available: binding.metadata?.nativeSession?.catalogueAvailable !== false })),
        inventoryAvailable: () => this.inventoryAvailable && !this.closed && this.ownsLease,
      });
      const saved = await readOptionalPrivateJson(join(this.directory, 'active-sources.json'));
      this.restored = new Set(Array.isArray(saved?.keys) ? saved.keys.filter((/** @type {unknown} */ key) => typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key)) : []);
      const machine = /** @type {Value} */ (this.machine);
      this.connection = (this.options.machineConnection ?? (options => new CodeLightMachineConnection(/** @type {any} */ (options))))({ serverUrl: this.options.account.serverUrl, token: this.options.account.token,
        machineId: machine.id, accountSecret: new Uint8Array(Buffer.from(this.options.account.secret, 'base64url')), metadata: machine.metadata, metadataVersion: machine.record?.metadataVersion ?? 0, onRpc: this.options.onRpc });
      this.connection.registerRpc('codelight-open-source', (/** @type {unknown} */ params) => this.openSource(params));
      this.connection.registerRpc('codelight-select-source', (/** @type {unknown} */ params) => this.selectSource(params));
      this.connection.registerRpc('codelight-observe-source', (/** @type {unknown} */ params) => this.observeSource(params));
      this.connection.registerRpc('codelight-receipt', (/** @type {unknown} */ params) => this.receipt(params));
      this.connection.registerRpc('codelight-close-source', (/** @type {unknown} */ params) => this.closeSource(params));
      this.connection.registerRpc('codelight-project-activity', (/** @type {Value} */ params) => {
        if (this.closed || !this.ownsLease) throw new BridgeError('source-unavailable', 'Project activity is unavailable.');
        return this.activity?.poll(params);
      });
      await this.connection.waitForConnect(); await this.scan();
      this.timer = setInterval(() => { this.scan().catch(() => this.emit('diagnostic', { code: 'discovery-scan-pending' })); }, this.options.scanMs ?? 20000); this.timer.unref();
      this.emit('ready', this.status()); return this.status();
    } catch (error) { await this.close(); throw error; }
  }
  status() { return { service: 'CodeLight', running: !this.closed && this.ownsLease, machineId: this.machine?.id ?? null, sources: this.sources.size, activeSources: this.actors.size, modelRunnersStarted: 0 }; }
  scan() {
    if (this.scanFlight) return this.scanFlight;
    this.scanFlight = this.scanOnce().finally(() => { this.scanFlight = null; }); return this.scanFlight;
  }
  async scanOnce() {
    if (this.closed || !this.ownsLease || !this.machine || !this.connection) throw new BridgeError('source-unavailable', 'The CodeLight daemon is unavailable.');
    const connection = this.connection;
    const found = await this.options.discovery.discover();
    this.inventoryAvailable = !(found.errors ?? []).includes('codex-index-unavailable');
    const seen = new Set();
    for (const error of found.errors ?? []) this.emit('diagnostic', { code: error });
    for (const source of found.sources) {
      if (!isCodeLightCodexSource(source) || this.options.only && !this.options.only(source)) continue;
      const key = sourceKey(source); const previous = this.sources.get(key);
      seen.add(key);
      if (previous) {
        previous.source = source;
        if (typeof this.registry.refreshMetadata === 'function' && this.connection?.socket) await this.registry.refreshMetadata(previous.binding, source, this.connection.socket).catch(() => this.emit('diagnostic', { code: 'source-metadata-pending' }));
        continue;
      }
      try {
        const binding = await this.registry.register(source, this.machine.id);
        if (typeof this.registry.refreshMetadata === 'function' && this.connection?.socket) await this.registry.refreshMetadata(binding, source, this.connection.socket);
        this.sources.set(key, { source, binding });
      }
      catch { this.emit('diagnostic', { code: 'source-registration-pending', sourceKey: key }); }
    }
    // 完整索引才有删除证据；读取失败不能把缓存目录全标成已移除。
    if (this.inventoryAvailable) {
      if (!this.cacheReconciled && typeof this.registry.savedBindings === 'function') {
        for (const binding of await this.registry.savedBindings()) {
          if (binding.machineId !== this.machine.id || seen.has(sourceKey(binding.source))) continue;
          await this.registry.markUnavailable(binding, connection.socket).catch(() => this.emit('diagnostic', { code: 'source-catalogue-update-pending' }));
        }
        this.cacheReconciled = true;
      }
      for (const [key, entry] of this.sources) if (!seen.has(key)) {
        if (typeof this.registry.markUnavailable === 'function') await this.registry.markUnavailable(entry.binding, connection.socket).catch(() => this.emit('diagnostic', { code: 'source-catalogue-update-pending' }));
        this.sources.delete(key);
      }
    }
    for (const key of this.restored) if (this.sources.has(key) && !this.actors.has(key)) {
      // 当前发行只恢复原生 Codex observer；旧 desktop-open、unknown 或模型命令不会重放。
      this.activate(key, null).catch(() => this.emit('diagnostic', { code: 'source-observation-pending', sourceKey: key }));
    }
    for (const key of this.restored) if (!this.sources.has(key)) {
      const binding = await readOptionalPrivateJson(join(this.directory, 'sources', `${key}.json`));
      if (!binding?.happySessionId || binding.serverUrl !== this.options.account.serverUrl || binding.machineId !== this.machine.id ||
        !isCodeLightCodexSource(binding.source, binding.metadata) || binding.metadata?.nativeSession?.catalogueAvailable === false ||
        this.inventoryAvailable && !seen.has(key) || sourceKey(binding.source) !== key) continue;
      const source = { ...binding.source, kind: binding.metadata?.bridge?.controlMode === 'window' ? 'window' : 'session' };
      this.sources.set(key, { source, binding }); this.activate(key, null).catch(() => this.emit('diagnostic', { code: 'source-observation-pending', sourceKey: key }));
    }
    return this.status();
  }
  /** @param {unknown} params */
  async openSource(params) {
    const value = validateParams(params, true), entry = this.sources.get(value.sourceKey);
    if (!entry || this.closed || !this.ownsLease) throw new BridgeError('source-unavailable', 'This source has not been discovered by the current CodeLight Mac.');
    if (entry.source.available === false && entry.source.kind === 'window') throw new BridgeError('source-unavailable', 'The original application/window is not available.');
    const receipt = await this.useSource(value.sourceKey, () => /** @type {CommandReceipts} */ (this.receipts).run(`codelight-machine:${this.machine?.id}`, value.commandId,
      { sourceKey: value.sourceKey, action: 'open-source' }, () => this.activate(value.sourceKey, value.commandId)));
    return { ok: true, receipt };
  }
  /** @param {unknown} params */
  receipt(params) { const value = validateParams(params, false); return { ok: true, receipt: this.receipts?.query(`codelight-machine:${this.machine?.id}`, value.commandId) ?? null }; }
  /** A fresh phone tap navigates immediately; initial snapshot hydration is asynchronous. @param {unknown} params */
  async selectSource(params) {
    const value = validateParams(params, true), input = /** @type {Value} */ (params);
    if (typeof input.selectionClient !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/u.test(input.selectionClient) || !Number.isSafeInteger(input.selectionSeq) || input.selectionSeq < 1) throw new BridgeError('invalid-selection', 'A stable phone selection order is required.');
    const latest = this.latestSelection.get(input.selectionClient) ?? 0;
    if (input.selectionSeq > latest) this.latestSelection.set(input.selectionClient, input.selectionSeq);
    const receipt = await this.useSource(value.sourceKey, () => /** @type {CommandReceipts} */ (this.receipts).run(`codelight-machine:${this.machine?.id}`, value.commandId,
      { sourceKey: value.sourceKey, action: 'select-source', selectionClient: input.selectionClient, selectionSeq: input.selectionSeq }, () => this.useSource(value.sourceKey, async () => {
        if (this.latestSelection.get(input.selectionClient) !== input.selectionSeq) throw new BridgeError('selection-superseded', 'A newer phone selection superseded this request.');
        const actor = await this.prepareSource(value.sourceKey);
        if (this.latestSelection.get(input.selectionClient) !== input.selectionSeq) throw new BridgeError('selection-superseded', 'A newer phone selection superseded this request.');
        this.restored.add(value.sourceKey); await this.saveRestored();
        if (this.latestSelection.get(input.selectionClient) !== input.selectionSeq) throw new BridgeError('selection-superseded', 'A newer phone selection superseded this request.');
        void this.startSource(value.sourceKey, actor).catch(() => this.emit('diagnostic', { code: 'source-observation-pending' }));
        await actor.openDesktop(value.commandId);
        return { sourceKey: value.sourceKey, desktopSwitchRequested: true, syncStarting: true };
      })));
    return { ok: true, receipt };
  }
  /** Foreground reconciliation resumes observation without desktop navigation. @param {unknown} params */
  async observeSource(params) {
    const value = validateParams(params, true);
    const receipt = await this.useSource(value.sourceKey, () => /** @type {CommandReceipts} */ (this.receipts).run(`codelight-machine:${this.machine?.id}`, value.commandId,
      { sourceKey: value.sourceKey, action: 'observe-source' }, () => this.useSource(value.sourceKey, async () => {
        const actor = await this.prepareSource(value.sourceKey);
        void this.startSource(value.sourceKey, actor).catch(() => this.emit('diagnostic', { code: 'source-observation-pending' }));
        return { sourceKey: value.sourceKey, syncStarting: true };
      })));
    return { ok: true, receipt };
  }
  saveRestored() {
    const write = this.activeSave.catch(() => {}).then(() => writeDurablePrivateJson(join(this.directory, 'active-sources.json'), { version: 1, keys: [...this.restored] }));
    this.activeSave = write; return write;
  }
  /** Stops this CodeLight observer only, never the original Agent. @param {unknown} params */
  async closeSource(params) {
    const value = validateParams(params, true);
    if (!this.sources.has(value.sourceKey) || this.closed || !this.ownsLease) throw new BridgeError('source-unavailable', 'This CodeLight source is unavailable.');
    const receipt = await /** @type {CommandReceipts} */ (this.receipts).run(`codelight-machine:${this.machine?.id}`, value.commandId, { sourceKey: value.sourceKey, action: 'close-source' }, async () => {
      await Promise.allSettled([this.activating.get(value.sourceKey), this.preparing.get(value.sourceKey), this.starts.get(value.sourceKey)]);
      const actor = this.actors.get(value.sourceKey); if (actor) { await actor.close(); this.actors.delete(value.sourceKey); }
      this.starts.delete(value.sourceKey); this.restored.delete(value.sourceKey); await this.saveRestored();
      return { sourceKey: value.sourceKey, observerClosed: true, originalAgentStopped: false };
    });
    return { ok: true, receipt };
  }
  /** @param {string} key @param {string|null} commandId */
  activate(key, commandId) {
    if (this.activating.has(key)) return /** @type {Promise<Value>} */ (this.activating.get(key));
    const flight = this.useSource(key, () => this.activateOnce(key, commandId)).finally(() => this.activating.delete(key)); this.activating.set(key, flight); return flight;
  }
  /** Source-scoped navigation pin; machine receipt serialization is not a source-use signal.
   * @param {string} key @param {()=>Promise<Value>} operation */
  useSource(key, operation) {
    this.sourceUses.set(key, (this.sourceUses.get(key) ?? 0) + 1);
    return Promise.resolve().then(operation).finally(() => {
      const count = (this.sourceUses.get(key) ?? 1) - 1;
      if (count) this.sourceUses.set(key, count); else this.sourceUses.delete(key);
    });
  }
  /** @param {string} key @param {string|null} commandId */
  async activateOnce(key, commandId) {
    const existing = this.actors.has(key), actor = await this.prepareSource(key), entry = /** @type {Value} */ (this.sources.get(key));
    try {
      this.restored.add(key); await this.saveRestored();
      if (commandId) await actor.openDesktop(commandId);
      await this.startSource(key, actor); return { sourceKey: key, happySessionId: entry.binding.happySessionId, sourceStatus: actor.status().sourceStatus };
    } catch (error) { if (!existing && this.actors.get(key) === actor) { this.actors.delete(key); await actor.close(); } throw error; }
  }
  /** @param {string} key @returns {Promise<Value>} */
  prepareSource(key) {
    const entry = this.sources.get(key);
    if (!entry || !isCodeLightCodexSource(entry.source, entry.binding.metadata) || this.closed || !this.ownsLease) return Promise.reject(new BridgeError('source-unavailable', 'This source is unavailable.'));
    const actor = this.actors.get(key); if (actor) { this.lastUsed.set(key, Date.now()); return Promise.resolve(actor); }
    const pending = this.preparing.get(key); if (pending) return pending;
    // 旧实现保留每次成功启动的 actor，第17次切换就永久撞容量；单飞预留并回收无用户/操作占用的旧 observer。
    const flight = this.capacityTail.then(async () => {
      if (this.closed || !this.ownsLease) throw new BridgeError('source-unavailable', 'This source is unavailable.');
      await this.makeRoom();
      const created = await this.sourceFactory({ account: this.options.account, binding: entry.binding, directory: join(this.directory, 'active', key), leaseDirectory: this.leaseDirectory,
        adapter: this.options.discovery.adapter(entry.source), assertHostLease: () => !this.closed && this.ownsLease });
      if (this.closed || !this.ownsLease) { await created.close(); throw new BridgeError('source-unavailable', 'This source is unavailable.'); }
      created.connector?.on('notification-observation', (/** @type {Value} */ summary) => this.emit('notification-observation', { sourceKey: key, sessionId: entry.binding.happySessionId, summary }));
      created.connector?.on('rpc-observation', (/** @type {Value} */ value) => { try { this.options.onRpc?.(value.method); } catch { /* Metrics never affect native admission. */ } });
      this.actors.set(key, created); this.lastUsed.set(key, Date.now()); return created;
    }).finally(() => { if (this.preparing.get(key) === flight) this.preparing.delete(key); });
    this.capacityTail = flight.then(() => {}, () => {});
    this.preparing.set(key, flight); return flight;
  }
  async makeRoom() {
    if (this.actors.size < (this.options.maxActiveSources ?? 16)) return;
    const candidates = [...this.actors].sort(([a], [b]) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0));
    for (const [key, actor] of candidates) {
      const binding = this.sources.get(key)?.binding;
      if (!binding || this.sourceUses.has(key) || this.activating.has(key) || this.preparing.has(key) || this.starts.has(key) ||
        this.options.viewedSessions?.().has(binding.happySessionId) || typeof actor.tryCloseIfIdle !== 'function') continue;
      if (!await actor.tryCloseIfIdle()) continue;
      if (this.actors.get(key) === actor) this.actors.delete(key);
      this.lastUsed.delete(key); this.starts.delete(key); this.restored.delete(key); await this.saveRestored();
      if (this.actors.size < (this.options.maxActiveSources ?? 16)) return;
    }
    throw new BridgeError('source-capacity', 'The current CodeLight observers are still in use.');
  }
  /** @param {string} key @param {Value} actor @returns {Promise<void>} */
  startSource(key, actor) {
    const pending = this.starts.get(key); if (pending) return pending;
    const start = (async () => {
      this.restored.add(key); await this.saveRestored(); await actor.start();
      if (this.closed || !this.ownsLease) throw new BridgeError('source-unavailable', 'The daemon closed while activating the source.');
    })().catch(async error => {
      this.starts.delete(key); if (this.actors.get(key) === actor) { this.actors.delete(key); await actor.close(); } throw error;
    }).finally(() => { if (this.starts.get(key) === start) this.starts.delete(key); });
    this.starts.set(key, start); return start;
  }
  async close() {
    if (this.closed) return; this.closed = true; this.ownsLease = false; if (this.timer) clearInterval(this.timer); this.connection?.close();
    await this.activity?.close();
    await Promise.allSettled([this.scanFlight, ...this.activating.values(), ...this.preparing.values(), ...this.starts.values(), this.activeSave]);
    await Promise.allSettled([...this.actors.values()].map(actor => actor.close())); this.actors.clear();
    await this.options.discovery.close?.(); await this.releaseLease?.().catch(() => {}); this.releaseLease = null;
  }
}

/** @param {unknown} params @param {boolean} needsSource @returns {{commandId:string,sourceKey:string}} */
function validateParams(params, needsSource) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new BridgeError('invalid-rpc-payload', 'A CodeLight machine request is required.');
  const value = /** @type {Value} */ (params);
  if (typeof value.commandId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/u.test(value.commandId)) throw new BridgeError('invalid-command-id', 'A stable commandId is required.');
  if (needsSource && (typeof value.sourceKey !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceKey))) throw new BridgeError('invalid-source', 'A discovered source key is required.');
  return { commandId: value.commandId, sourceKey: value.sourceKey ?? '' };
}
