/** Noninvasive single-source Happy connector. Native execution is owned by the
 * supplied original adapter and Root CommandReceipts/lease; no runners exist here.
 * Happy record/envelope conventions: slopus/happy ee5ccff79b046570dc7e62eeec90e7c8a9d7027e, MIT.
 */
import { EventEmitter } from 'node:events';
import { pendingNativeAsyncQuestions } from '../native-question-scope.mjs';
import { recentRowsPage } from './recent-data.mjs';
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { BridgeError } from '../errors.mjs';
import { nativeCauseCode } from '../commands.mjs';
import { encryptRecord, decryptRecord } from './session-transport.mjs';
import { archiveObserverCheckpointPayload, readArchivedObserverRows, validateObserverHistoryReferences } from './observer-history.mjs';
import { SOURCE_APPS } from './source-registry.mjs';
import { notificationSummary } from './notification-dispatcher.mjs';
import { rpcTarget } from '@slopus/happy-wire/codelight';

/** @typedef {Record<string, any>} Value */
/** @typedef {{snapshot:(id:string)=>Promise<Value>,freshSnapshot?:(id:string)=>Promise<Value>,completeSnapshot?:(id:string)=>Promise<Value>,subscribe:(id:string,onView:(view:Value)=>void)=>Promise<()=>void>,command:(id:string,action:string,payload:Value,commandId:string,context?:{expectedGeneration:string|null})=>Promise<Value>,supportsNativeModelSettings?:boolean}} NativeAdapter */
/** @typedef {{run:(scope:string,id:string,payload:unknown,execute:()=>Promise<unknown>)=>Promise<any>,query:(scope:string,id:string)=>any}} Receipts */
/** @typedef {{transport:any,adapter:NativeAdapter,nativeId:string,sourceIdentity:Value,bindingId:string,metadata?:Value,receipts:Receipts,statePath:string,encryptionKey:Uint8Array,getGeneration?:()=>unknown|Promise<unknown>,assertLease?:()=>unknown|Promise<unknown>,leaseRequired?:boolean,admissionTimeoutMs?:number,supportsNativeProjection?:boolean,recentRowLimit?:number}} ConnectorOptions */
const owners = new Set();
const BAD_SOURCE = new Set(['owner-unavailable', 'disconnected', 'locked', 'permission-required', 'unavailable', 'codex-unavailable', 'not-loaded']);
const SAFE_NATIVE_ERRORS = new Set(['stale-turn', 'stale-question', 'stale-approval', 'unsupported-action', 'unsupported-approval', 'invalid-input', 'invalid-turn', 'invalid-payload', 'invalid-response', 'invalid-answer-identity', 'approval-details-unavailable', 'permission-expansion', 'source-epoch-changed', 'source-generation-unavailable', 'source-lease-unavailable', 'source-unavailable', 'settings-conflict', 'unsupported-model-settings', 'native-settings-unavailable', 'native-model-catalog-unavailable', 'invalid-settings']);

/** @param {unknown} value @returns {value is Value} */
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value @returns {string} */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** @param {unknown} value */
function hash(value) { return createHash('sha256').update(stable(value)).digest('hex'); }
/** @param {unknown} value @param {string} label */
function id(value, label) { if (typeof value !== 'string' || !value || value.length > 512) throw new BridgeError('invalid-connector-options', `${label} is required.`); return value; }
/** @param {unknown} value */
function commandId(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/u.test(value)) throw new BridgeError('invalid-command-id', 'A stable commandId is required.'); return value; }
/** @param {Value} value */
function viewOf(value) { return object(value.native) ? value.native : value; }
/** @param {Value} view */
function available(view) { return Array.isArray(view.rows) && typeof view.status === 'string' && !BAD_SOURCE.has(view.status) && !['unknown', 'error', 'failed'].includes(view.status); }
/** @param {unknown} status */
function terminal(status) { return ['completed', 'complete', 'stop'].includes(/** @type {string} */ (status)) ? 'completed' : ['cancelled', 'canceled', 'interrupted'].includes(/** @type {string} */ (status)) ? 'cancelled' : ['failed', 'error'].includes(/** @type {string} */ (status)) ? 'failed' : null; }
/** @param {string} text */
function safePrefix(text) { const last = text.charCodeAt(text.length - 1); return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text; }

/** @param {Value} view @param {string} commandId @param {unknown} messageId */
function observedInputRow(view, commandId, messageId) {
  // 失败的本地 admission 也会留下带 caller ID 的占位输入；没有原 turn ID 就不能据此确认消息已接受。
  return (view.rows ?? []).find((/** @type {Value} */ row) => row.role === 'user' &&
    typeof row.turnId === 'string' && row.turnId.trim() &&
    !['pending', 'rejected', 'failed'].includes(row.inputStatus) &&
    (row.commandId === commandId || messageId && row.id === messageId) && !['draft', 'optimistic'].includes(row.status));
}

export class NativeHappyConnector extends EventEmitter {
  /** @type {ConnectorOptions} */ #options;
  /** @type {Uint8Array} */ #key;
  /** @type {Value} */ #state = {};
  /** @type {Value} */ #view = { rows: [], requests: [], status: 'owner-unavailable', currentTurnId: null };
  /** @type {string|null} */ #diskText = null;
  #ioTail = Promise.resolve();
  /** @type {Promise<void>|null} */ #inputFlight = null;
  #inputDirty = false;
  /** @type {Promise<void>|null} */ #flushFlight = null;
  /** @type {Map<string,Promise<Value>>} */ #commandFlights = new Map();
  /** @type {(()=>void)|null} */ #release = null;
  /** @type {Array<()=>void>} */ #rpcReleases = [];
  #started = false;
  #closed = false;
  #ownsState = false;
  /** @type {Value|null} */ #pendingView = null;
  /** @type {Promise<void>|null} */ #projectFlight = null;
  /** @type {Promise<void>|null} */ #startFlight = null;
  #starting = false;
  #retiring = false;
  /** @type {Promise<void>|null} */ #closeFlight = null;
  /** @type {Set<Promise<unknown>>} */ #operations = new Set();
  /** @type {Promise<void>|null} */ #attachFlight = null;
  /** @type {ReturnType<typeof setInterval>|null} */ #retryTimer = null;
  /** @type {Value} */ #metadata;
  /** @type {Value|null} */ #nativeControls = null;
  /** @type {Promise<Value>|null} */ #controlsFlight = null;
  #controlsReadAt = 0;
  /** @type {string|null} */ #controlsEpoch = null;
  #controlsRevision = 0;

  /** @param {ConnectorOptions} options */
  constructor(options) {
    super({ captureRejections: true });
    this.#options = options;
    if (options.recentRowLimit !== undefined && (!Number.isSafeInteger(options.recentRowLimit) || options.recentRowLimit < 1 || options.recentRowLimit > 200)) throw new BridgeError('invalid-row-limit', 'The recent observation row limit is invalid.');
    this.nativeId = id(options.nativeId, 'Original native id'); this.bindingId = id(options.bindingId, 'Stable binding id');
    if (!object(options.sourceIdentity) || !SOURCE_APPS.includes(options.sourceIdentity.app) || options.sourceIdentity.id !== this.nativeId) throw new BridgeError('invalid-source-identity', 'Bind the verified original source identity, not a Happy session id.');
    if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32 || !isAbsolute(options.statePath)) throw new BridgeError('invalid-connector-options', 'An owned absolute checkpoint path and 32-byte key are required.');
    this.#key = new Uint8Array(options.encryptionKey); this.statePath = resolve(options.statePath);
    this.receiptScope = `happy-native:${options.transport.sessionId}:${hash([this.bindingId, this.nativeId]).slice(0, 32)}`;
    this.#metadata = structuredClone(options.metadata ?? { path: '', host: options.sourceIdentity.hostId ?? 'local', client: { id: 'noninvasive-bridge', name: 'Existing desktop bridge', version: '1' } });
    this.on('error', () => this.emit('diagnostic', { code: 'connector-observer-error' }));
  }

  status() { return { started: this.#started, closed: this.#closed, retiring: this.#retiring, activeOperations: this.#operations.size, nativeId: this.nativeId, bindingId: this.bindingId,
    sourceStatus: this.#state.sourceStatus ?? 'owner-unavailable', currentTurnId: this.#view.currentTurnId ?? null,
    projectionStatus: this.#state.projectionStatus ?? 'unknown', commands: this.#state.commands?.length ?? 0,
    pendingEvents: this.#state.events?.filter((/** @type {Value} */ event) => !event.sent).length ?? 0 }; }

  /** Full row seeds for an authenticated selected-session read, never a new native command.
   * @param {{fresh?:boolean,cursor?:unknown,limit?:unknown}} [options] @returns {Promise<Value>} */
  async readRecent(options = {}) {
    return this.#operation(async () => {
    if (this.#closed || this.#retiring) throw new BridgeError('source-unavailable', 'The selected observer is unavailable.', 503);
    await this.start();
    if (this.#closed || this.#retiring) throw new BridgeError('source-unavailable', 'The selected observer is unavailable.', 503);
    if (options.fresh !== false) {
      if (typeof this.#options.adapter.freshSnapshot !== 'function') throw new BridgeError('fresh-native-unavailable', 'This observer cannot confirm a fresh original-owner view.', 503);
      const fresh = viewOf(await this.#options.adapter.freshSnapshot(this.nativeId));
      if (!available(fresh)) throw new BridgeError('source-unavailable', 'The original owner did not provide a fresh usable view.', 503);
      if (this.#closed || this.#retiring || typeof fresh.ownerGeneration === 'string' && fresh.ownerGeneration !== await this.#epoch()) throw new BridgeError('source-epoch-changed', 'The original owner changed during the recent read.', 409);
      await this.project(fresh);
    } else if (options.cursor && this.#view.historyComplete === false) {
      if (typeof this.#options.adapter.completeSnapshot !== 'function') throw new BridgeError('complete-history-unavailable', 'The original observer cannot load earlier native history.', 503);
      const complete = viewOf(await this.#options.adapter.completeSnapshot(this.nativeId));
      if (!available(complete) || complete.historyComplete !== true) throw new BridgeError('complete-history-unconfirmed', 'The original owner has not confirmed complete history.', 503);
      if (this.#closed || this.#retiring || typeof complete.ownerGeneration === 'string' && complete.ownerGeneration !== await this.#epoch()) throw new BridgeError('source-epoch-changed', 'The original owner changed during the history read.', 409);
      await this.project(complete);
    }
    const view = this.#view;
    if (this.#closed || this.#retiring || !available(view)) throw new BridgeError('source-unavailable', 'The original native view is unavailable.', 503);
    if (typeof view.ownerGeneration === 'string' && view.ownerGeneration !== await this.#epoch()) throw new BridgeError('source-epoch-changed', 'The original owner changed during the native read.', 409);
    const page = recentRowsPage(this.#options.transport.sessionId, view.rows ?? [], { ...options, historyComplete: view.historyComplete });
    return { ...page, rows: page.rows.map((/** @type {Value} */ row) => {
      const saved = this.#state.rows.find((/** @type {Value} */ item) => item.id === row.id);
      const ownInput = row.role === 'user' ? this.#state.commands.find((/** @type {Value} */ command) => command.origin === 'message'
        && command.admission?.confirmed && (row.commandId === command.id || command.result?.messageId === row.id)) : null;
      // 首屏不能再复制手机已确认的输入；原 broker/local id 把 native 行接回同一个 optimistic/echo 行。
      const inputAliases = ownInput ? [ownInput.serverId, ownInput.key?.startsWith('message:') ? ownInput.key.slice(8) : null].filter(Boolean) : [];
      const streamRevision = row.role === 'tool' ? Math.max(0, ...(row.tools ?? []).map((/** @type {Value} */ tool) => this.#state.rows.find((/** @type {Value} */ item) => item.id === `tool:${tool.id}`)?.revision ?? 0)) : saved?.revision ?? 0;
      // 首屏完整原生行替换明确的镜像片段，不能把最近50条协议增量误当作50条完整消息。
      return { ...row, replaceIds: [...new Set([...(saved?.eventIds ?? []), ...(saved?.replacedWireIds ?? []), ...inputAliases])], projectionRevision: Math.max(1, streamRevision), streamRevision,
        snapshotRevision: this.#state.recentVersion ?? 1, ownerGeneration: this.#state.epoch };
    }), revision: view.revision ?? null, ownerGeneration: this.#state.epoch, status: view.status,
      currentTurnId: view.currentTurnId ?? null, seq: this.#options.transport.peerSnapshot?.().seq ?? 0,
      historyComplete: view.historyComplete ?? null, historyCoverage: view.historyComplete === true ? 'complete-native-view' : 'loaded-native-view' };
    });
  }

  start() {
    if (!this.#startFlight) { this.#starting = true; this.#startFlight = this.#start().catch(async error => {
      this.#closed = true; this.#release?.(); this.#release = null;
      for (const release of this.#rpcReleases.splice(0)) release();
      await this.#ioTail; this.#releaseState(); throw error;
    }).finally(() => { this.#starting = false; }); }
    return this.#startFlight;
  }
  async #start() {
    if (owners.has(this.statePath)) throw new BridgeError('connector-in-use', 'This connector checkpoint already has an owner.');
    owners.add(this.statePath);
    this.#ownsState = true;
    try { await this.#load(); if (this.#closed) throw new BridgeError('connector-closed', 'The connector closed while starting.'); this.#started = true; await this.#options.transport.start(); }
    catch (error) { this.#releaseState(); throw error; }
    if (this.#closed) throw new BridgeError('connector-closed', 'The connector closed while connecting.');
    const onRecord = () => { this.processInbox().catch(() => this.emit('diagnostic', { code: 'connector-input-pending' })); };
    this.#options.transport.on('record', onRecord);
    this.#rpcReleases.push(() => this.#options.transport.removeListener('record', onRecord));
    this.#registerRpc('abort', params => this.#rpc('abort', params));
    this.#registerRpc('permission', params => this.#rpc('permission', params));
    this.#registerRpc('communication', params => this.#rpc('communication', params));
    this.#registerRpc('bridge-receipt', params => this.#receiptQuery(params));
    this.#registerRpc('open-desktop', params => this.#rpc('open-desktop', params));
    if (this.#options.adapter.supportsNativeModelSettings === true) {
      this.#registerRpc('codex-controls-read', params => this.#readControlsRpc(params));
      this.#registerRpc('codex-controls-update', params => this.#rpc('codex-controls-update', params));
    }
    this.#registerRpc('window-control', params => this.#rpc('window-control', params));
    await this.#collectBootstrap();
    try { this.#view = viewOf(await this.#options.adapter.snapshot(this.nativeId)); }
    catch { this.#view = { rows: [], requests: [], currentTurnId: null, status: 'owner-unavailable' }; }
    await this.#seedBootstrap(this.#view);
    await this.#attachSource();
    if (this.#closed) throw new BridgeError('connector-closed', 'The connector closed while subscribing.');
    await this.project(this.#view); await this.processInbox();
    this.#retryTimer = setInterval(() => { if (!this.#closed) {
      if (this.#state.sourceStatus === 'connected') this.#options.transport.keepAlive?.(typeof this.#view.currentTurnId === 'string');
      if (!this.#release) this.#attachSource().catch(() => this.emit('diagnostic', { code: 'source-observation-unavailable' }));
      this.processInbox().catch(() => this.emit('diagnostic', { code: 'connector-publication-pending' }));
    } }, 5000);
    this.#retryTimer.unref();
  }

  /** @param {string} method @param {(params:unknown)=>Promise<Value>} handler */
  #registerRpc(method, handler) {
    this.#rpcReleases.push(this.#options.transport.registerRpc(method, (/** @type {unknown} */ params) => {
      this.emit('rpc-observation', { method });
      return this.#operation(() => handler(params));
    }));
  }
  /** @template T @param {()=>Promise<T>} execute @returns {Promise<T>} */
  #operation(execute) {
    if (this.#closed || this.#retiring) return Promise.reject(new BridgeError('source-unavailable', 'The CodeLight observer is closing.'));
    // 在 epoch 读取、计划落盘之前占用入口，避免 LRU 检查漏掉已进入但尚未 dispatch 的 RPC。
    const flight = Promise.resolve().then(() => {
      if (this.#closed || this.#retiring) throw new BridgeError('source-unavailable', 'The CodeLight observer is closing.');
      return execute();
    }).finally(() => { this.#operations.delete(flight); });
    this.#operations.add(flight); return flight;
  }

  #attachSource() {
    if (this.#attachFlight || this.#release || this.#closed) return this.#attachFlight ?? Promise.resolve();
    this.#attachFlight = (async () => {
      try {
        const release = await this.#options.adapter.subscribe(this.nativeId, frame => {
          if (!this.#closed) this.project(viewOf(frame)).catch(() => this.emit('diagnostic', { code: 'connector-projection-pending' }));
        });
        if (this.#closed) release(); else this.#release = release;
      } catch {
        // 原应用没有打开这个 idle 会话时，只等待它自己的 owner；不能退回第二个 runtime。
        this.#view = { rows: [], requests: [], currentTurnId: null, status: 'owner-unavailable' };
        await this.project(this.#view);
      }
    })().finally(() => { this.#attachFlight = null; });
    return this.#attachFlight;
  }

  async #load() {
    const identity = { happySessionId: this.#options.transport.sessionId, nativeId: this.nativeId, bindingId: this.bindingId,
      source: { app: this.#options.sourceIdentity.app, id: this.nativeId, hostId: this.#options.sourceIdentity.hostId }, keyFingerprint: hash(Buffer.from(this.#key).toString('base64')) };
    let stored = null;
    try { stored = await readFile(this.statePath, 'utf8'); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
    if (stored) {
      let saved;
      try { saved = JSON.parse(stored); } catch { throw new BridgeError('invalid-connector-checkpoint', 'The connector checkpoint could not be decoded.'); }
      if (saved.format !== 'happy-native-connector-v1' || stable(saved.identity) !== stable(identity)) throw new BridgeError('connector-identity-mismatch', 'The checkpoint does not match this source/Happy/key binding.');
      const bundle = Buffer.from(saved.ciphertext, 'base64');
      if (bundle.length < 29 || bundle[0] !== 0) throw new BridgeError('connector-decryption-failed', 'The connector checkpoint has an unsupported encrypted format.');
      try { const cipher = createDecipheriv('aes-256-gcm', this.#key, bundle.subarray(1, 13)); cipher.setAuthTag(bundle.subarray(-16)); this.#state = JSON.parse(Buffer.concat([cipher.update(bundle.subarray(13, -16)), cipher.final()]).toString('utf8')); }
      catch { throw new BridgeError('connector-decryption-failed', 'The connector checkpoint could not be decrypted.'); }
      if (!Array.isArray(this.#state.rows) || !Array.isArray(this.#state.events) || !Array.isArray(this.#state.commands) || !Array.isArray(this.#state.turns)) throw new BridgeError('invalid-connector-checkpoint', 'The connector checkpoint is missing required journals.');
      this.#diskText = stored;
      await validateObserverHistoryReferences(this.#state, this.statePath);
      for (const command of this.#state.commands) {
        if (command.state === 'dispatching') { command.state = 'unknown'; command.error = 'connector-restarted'; }
        // 修复旧版本对无 turn ID 占位行的误确认；只纠正派生回执，原命令及 unknown 记录保留且不重新派发。
        if (command.admission?.confirmed && !command.admission.queued &&
            (typeof command.admission.turnId !== 'string' || !command.admission.turnId.trim())) {
          command.admission = null; command.resolvedByObservation = false;
        }
      }
      await this.#save(this.#state, identity); return;
    }
    this.#state = { identity, revision: 0, clock: 0, rows: [], turns: [], commands: [], events: [], bootstrap: [], requestMap: [], sourceStatus: 'owner-unavailable', projectionStatus: 'ready' };
    await this.#save(this.#state, identity);
  }

  /** @param {Value} state @param {Value} [identity] */
  async #save(state, identity = state.identity) {
    let current = null; try { current = await readFile(this.statePath, 'utf8'); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
    if (current !== this.#diskText) throw new BridgeError('connector-checkpoint-conflict', 'The owned connector checkpoint changed elsewhere.');
    let plain = Buffer.from(JSON.stringify(state));
    if (this.#options.sourceIdentity.app === 'codex' && plain.length >= 8 * 1024 * 1024) {
      // 已确认镜像及离开窗口的完整前缀有独立加密历史；命令、未发事件与行别名仍由当前检查点拥有。
      if (await archiveObserverCheckpointPayload(state, this.statePath, this.#key, plain.length > 32 * 1024 * 1024 ? 0 : 4 * 1024 * 1024)) plain = Buffer.from(JSON.stringify(state));
    }
    if (plain.length > 32 * 1024 * 1024) throw new BridgeError('connector-capacity', 'The connector checkpoint reached its explicit size bound.');
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, nonce), encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const text = JSON.stringify({ format: 'happy-native-connector-v1', identity, ciphertext: Buffer.concat([Buffer.from([0]), nonce, encrypted, cipher.getAuthTag()]).toString('base64') });
    const folder = dirname(this.statePath); await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); await handle.close(); await rename(temporary, this.statePath); const dir = await open(folder, 'r'); try { await dir.sync(); } finally { await dir.close(); } this.#diskText = text; }
    catch (error) { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  }

  /** @template T @param {(state:Value)=>T} change @returns {Promise<T>} */
  #mutate(change) {
    const result = this.#ioTail.catch(() => {}).then(async () => { const state = structuredClone(this.#state), value = change(state); state.revision++; await this.#save(state); this.#state = state; return value; });
    this.#ioTail = result.then(() => {}, () => {}); return result;
  }
  /** @param {unknown} value */ #mac(value) { return createHmac('sha256', this.#key).update(stable(value)).digest('hex'); }
  async #epoch() { const value = this.#options.getGeneration ? await this.#options.getGeneration() : this.#options.sourceIdentity.runtimeGeneration; return value === null || value === undefined || value === '' ? null : typeof value === 'string' ? value : stable(value); }
  async #lease() { if (this.#options.leaseRequired === false) return true; if (!this.#options.assertLease) return false; try { return (await this.#options.assertLease()) !== false; } catch { return false; } }
  /** @param {Value} plan */
  async #guard(plan) {
    if (this.#closed) throw new BridgeError('source-unavailable', 'The connector is closing.');
    if (!await this.#lease()) throw new BridgeError('source-lease-unavailable', 'The original source lease is unavailable.');
    if (plan.action === 'open-desktop') {
      if (this.#options.sourceIdentity.app !== 'codex' || this.#options.sourceIdentity.hostId !== 'local') throw new BridgeError('source-unavailable', 'Only the bound local desktop chat can be opened.');
      return this.#view;
    }
    const epoch = await this.#epoch(); if (epoch === null) throw new BridgeError('source-generation-unavailable', 'The original source generation is unavailable.');
    if (epoch !== plan.epoch) throw new BridgeError('source-epoch-changed', 'The original source generation changed.');
    const view = viewOf(await this.#options.adapter.snapshot(this.nativeId)); this.#view = view;
    // snapshot/getGeneration均为异步，窗口/owner可能在读取期间更换；派发前再核对，不能只用读取前epoch。
    if (!await this.#lease()) throw new BridgeError('source-lease-unavailable', 'The source lease changed before dispatch.');
    if (await this.#epoch() !== plan.epoch) throw new BridgeError('source-epoch-changed', 'The original source changed while reading its current view.');
    if (plan.windowControl) {
      if (!available(view) || view.kind !== 'window') throw new BridgeError('source-unavailable', 'The bound original window is unavailable.');
      if (plan.action === 'type' && view.textInputAvailable === false) throw new BridgeError('unsupported-action', 'This window has no verified editable Agent draft.');
      if (['click', 'scroll'].includes(plan.action) && view.coordinateControlAvailable === false) throw new BridgeError('unsupported-action', 'This window has no verified coordinate control.');
      if ((plan.action === 'press' || plan.action === 'key' && plan.payload.nodeId) && view.semanticControlAvailable === false) throw new BridgeError('unsupported-action', 'This window has no verified accessibility control.');
      return view;
    }
    if (!available(view) || view.kind === 'window' || this.#options.sourceIdentity.app !== 'codex') throw new BridgeError('source-unavailable', 'This source has no verified native session control.');
    if (plan.action === 'interrupt' && view.currentTurnId !== plan.payload.turnId) throw new BridgeError('stale-turn', 'The foreground native turn changed; no other turn was stopped.');
    if (plan.action === 'steer' && view.currentTurnId !== plan.expectedTurnId) throw new BridgeError('stale-turn', 'The original foreground turn changed before steering.');
    if (plan.action === 'send' && view.currentTurnId != null) throw new BridgeError('stale-turn', 'A foreground turn started before this idle input was submitted.');
    if (plan.request) {
      const present = plan.request.type === 'async-question'
        ? pendingNativeAsyncQuestions(view).some((/** @type {Value} */ question) => question.questionItemId === plan.request.questionItemId)
        : (view.requests ?? []).some((/** @type {Value} */ request) => request.kind === plan.request.kind && stable(request.requestId) === stable(plan.request.requestId) && request.operable === true && (!plan.request.digest || this.#mac(request) === plan.request.digest));
      if (!present) throw new BridgeError(plan.request.type === 'async-question' ? 'stale-question' : 'stale-approval', 'The original pending request is no longer available.');
    }
    return view;
  }

  async #collectBootstrap() {
    const candidates = this.#options.transport.listInbox().filter((/** @type {Value} */ incoming) => incoming.record?.role === 'session' && typeof (incoming.record.content?.data ?? incoming.record.content)?.ev?.text === 'string');
    if (!candidates.some((/** @type {Value} */ candidate) => !this.#state.bootstrap?.some((/** @type {Value} */ item) => item.serverId === candidate.id))) return;
    await this.#mutate(state => {
      state.bootstrap ??= [];
      for (const candidate of candidates) if (!state.bootstrap.some((/** @type {Value} */ item) => item.serverId === candidate.id)) state.bootstrap.push({ serverId: candidate.id, ciphertext: encryptRecord(candidate.record, this.#key) });
    });
  }

  /** @param {Value} view */
  async #seedBootstrap(view) {
    if (!this.#state.bootstrap?.length) return;
    const known = new Set(this.#state.rows.map((/** @type {Value} */ row) => row.id));
    if (!this.#mirrorRows(view).some(row => !known.has(row.id))) return;
    const inbox = (this.#state.bootstrap ?? []).map((/** @type {Value} */ saved) => ({ record: decryptRecord(saved.ciphertext, this.#key) }));
    await this.#mutate(state => {
      for (const row of this.#mirrorRows(view)) {
        if (state.rows.some((/** @type {Value} */ entry) => entry.id === row.id)) continue;
        if (!row.id || !row.turnId || typeof row.text !== 'string' || !['user', 'assistant', 'reasoning'].includes(row.role)) continue;
        const expected = 'ni' + createHash('sha256').update(`${this.nativeId}:${row.id}:bootstrap`).digest('hex').slice(0, 28);
        const observed = inbox.find((/** @type {Value} */ incoming) => {
          const record = incoming.record, envelope = record?.content?.data ?? record?.content;
          return record?.role === 'session' && envelope?.id === expected && envelope.turn === row.turnId && envelope.role === (row.role === 'user' ? 'user' : 'agent') && typeof envelope.ev?.text === 'string' && row.text.startsWith(envelope.ev.text);
        });
        if (!observed) continue;
        const envelope = observed.record.content.data ?? observed.record.content, text = envelope.ev.text;
        state.rows.push({ id: row.id, role: row.role, turnId: row.turnId, text, digest: this.#mac(text), eventIds: [expected], revision: 0 });
        state.clock = Math.max(state.clock, envelope.time ?? 0);
        if (!state.turns.some((/** @type {Value} */ turn) => turn.id === row.turnId)) state.turns.push({ id: row.turnId, started: true, ended: null });
      }
    });
  }

  /** @param {Value} view @returns {Promise<void>} */
  project(view) {
    if (this.#closed || this.#retiring) return Promise.resolve();
    return this.#operation(() => this.#acceptProject(view));
  }
  /** @param {Value} view @returns {Promise<void>} */
  async #acceptProject(view) {
    const actual = viewOf(view), epoch = await this.#epoch();
    if (this.#closed || this.#retiring) return;
    if (epoch === this.#state.epoch && Number.isSafeInteger(actual.revision) && Number.isSafeInteger(this.#state.lastViewRevision) && actual.revision < this.#state.lastViewRevision) { this.emit('diagnostic', { code: 'stale-native-projection' }); return; }
    this.#view = actual;
    if (!this.#projectFlight && !this.#pendingView && actual.contentStamp
      && this.#state.recentStamp === `${epoch ?? 'unknown'}:${actual.contentStamp}` && this.#state.epoch === epoch) return;
    this.#pendingView = structuredClone(actual);
    if (!this.#projectFlight) this.#projectFlight = (async () => { while (this.#pendingView && !this.#closed) { const next = this.#pendingView; this.#pendingView = null; await this.#project(next); } })().finally(() => { this.#projectFlight = null; });
    return this.#projectFlight;
  }

  /** @param {Value} view */
  async #project(view) {
    const epoch = await this.#epoch(), lease = await this.#lease();
    await this.#seedBootstrap(view);
    const activeRowIds = new Set(this.#mirrorRows(view).flatMap(row => [row.id, ...(row.tools ?? []).map((/** @type {Value} */ tool) => `tool:${tool.id}`)]));
    const restoredRows = await readArchivedObserverRows(this.#state, this.statePath, this.#key, activeRowIds);
    await this.#mutate(state => {
      for (const [rowId, row] of restoredRows) {
        const index = state.rows.findIndex((/** @type {Value} */ item) => item.id === rowId);
        if (index >= 0 && state.rows[index].historyRef) state.rows[index] = row;
      }
      state.activeRowIds = [...activeRowIds];
      state.sourceStatus = available(view) ? (view.status === 'locked' ? 'locked' : 'connected') : view.status === 'locked' ? 'locked' : 'owner-unavailable';
      state.epoch = epoch; state.currentTurnId = view.currentTurnId ?? null;
      state.lastViewRevision = Number.isSafeInteger(view.revision) ? view.revision : null;
      if (view.kind === 'window' || this.#options.sourceIdentity.app !== 'codex') return;
      this.#reconcileCommands(state, view);
      const groups = new Map();
      for (const row of this.#mirrorRows(view)) {
        if (!row.id || !row.turnId) continue;
        groups.set(row.turnId, [...(groups.get(row.turnId) ?? []), row]);
        let entry = state.rows.find((/** @type {Value} */ item) => item.id === row.id);
        const own = row.role === 'user' && state.commands.some((/** @type {Value} */ command) => command.origin === 'message' && command.admission?.confirmed && (row.commandId === command.id || command.result?.messageId === row.id));
        if (own) {
          if (!entry) state.rows.push({ id: row.id, turnId: row.turnId, role: 'user', text: row.text ?? '', digest: this.#mac(row.text ?? ''), eventIds: [], suppressedOwnEcho: true });
          continue;
        }
        if (!entry) { entry = { id: row.id, turnId: row.turnId, role: row.role, text: '', digest: this.#mac(''), eventIds: [], revision: 0 }; state.rows.push(entry); }
        if (['user', 'assistant', 'reasoning'].includes(row.role) && typeof row.text === 'string') {
          const text = safePrefix(row.text); if (entry.digest !== this.#mac(entry.text)) throw new BridgeError('prefix-integrity-error', 'The stored native text prefix did not match its HMAC.');
          const replacedSources = Array.isArray(row.replaceSourceRowIds) ? row.replaceSourceRowIds : [];
          const aliasesChanged = stable(entry.replaceSourceRowIds ?? []) !== stable(replacedSources);
          if (text === entry.text && (!text || entry.rowIdentityVersion === 1) && !aliasesChanged) continue;
          this.#turnStart(state, row.turnId);
          const provisional = row.role === 'user' && row.commandId && row.id !== `pending-user:${row.commandId}`
            ? state.rows.find((/** @type {Value} */ item) => item.id === `pending-user:${row.commandId}`) : null;
          const legacyPrefix = !!entry.text && entry.rowIdentityVersion !== 1;
          if (text.startsWith(entry.text) && row.role === entry.role && row.turnId === entry.turnId && !provisional?.eventIds?.length && !legacyPrefix && !aliasesChanged) {
            const eventId = 'ni' + hash([this.bindingId, row.id, entry.text.length, text.length, this.#mac(text)]).slice(0, 28);
            this.#event(state, eventId, row.role === 'user' ? 'user' : 'agent', row.turnId, { t: 'text', text: text.slice(entry.text.length), ...(row.role === 'reasoning' ? { thinking: true } : {}) },
              { nativeRow: { id: row.id, offset: entry.text.length, revision: entry.revision ?? 0 } });
            entry.eventIds.push(eventId);
          } else {
            state.projectionStatus = this.#options.supportsNativeProjection ? 'ready' : 'resync-required'; entry.revision = (entry.revision ?? 0) + 1;
            const eventId = 'ni' + hash([this.bindingId, row.id, 'replace', entry.revision, this.#mac(text)]).slice(0, 28);
            const sourceWireIds = replacedSources.flatMap((/** @type {string} */ sourceId) => state.rows.find((/** @type {Value} */ item) => item.id === sourceId)?.eventIds ?? []);
            entry.replacedWireIds = [...new Set([...(entry.replacedWireIds ?? []), ...entry.eventIds, ...(provisional?.eventIds ?? []), ...sourceWireIds])];
            this.#event(state, eventId, row.role === 'user' ? 'user' : 'agent', row.turnId, { t: 'native-row-upsert', sourceRowId: row.id, role: row.role, text, revision: entry.revision,
              replaceIds: entry.replacedWireIds, ...(replacedSources.length ? { replaceSourceRowIds: replacedSources } : {}) });
            entry.eventIds = [eventId];
          }
          entry.text = text; entry.digest = this.#mac(text); entry.role = row.role; entry.turnId = row.turnId;
          entry.rowIdentityVersion = 1;
          entry.replaceSourceRowIds = replacedSources;
        }
        for (const tool of row.tools ?? []) this.#tool(state, row, tool);
      }
      for (const [turnId, rows] of groups) {
        const status = rows.map((/** @type {Value} */ row) => terminal(row.status)).filter(Boolean).at(-1);
        const turn = state.turns.find((/** @type {Value} */ item) => item.id === turnId);
        if (status && turn?.started && !turn.ended && view.currentTurnId !== turnId) { this.#event(state, 'ni' + hash([this.bindingId, turnId, 'turn-end', status]).slice(0, 28), 'agent', turnId, { t: 'turn-end', status }); turn.ended = status; }
      }
      state.requestMap = this.#requestMap(view, epoch);
      const recentStamp = `${epoch ?? 'unknown'}:${view.contentStamp ?? hash(view.rows ?? [])}`;
      // 原 owner 的静默 stdout 快照可能沿用同一 revision；另存投影版本，不能让新鲜完整行被旧 seed 去重。
      if (state.recentStamp !== recentStamp) { state.recentStamp = recentStamp; state.recentVersion = (state.recentVersion ?? 0) + 1; }
    });
    await this.#publishMetadata(view, epoch, lease); await this.#flushEvents();
    if (lease && epoch && available(view) && view.kind !== 'window' && this.#options.sourceIdentity.app === 'codex') this.emit('notification-observation', { ...notificationSummary(view, this.#state.requestMap), epoch });
  }

  /** Only the observer publication window is bounded; native commands/questions/history retain full evidence.
   * @param {Value} view @returns {Value[]} */
  #mirrorRows(view) {
    const rows = view.rows ?? [];
    return this.#options.recentRowLimit === undefined ? rows : rows.slice(-this.#options.recentRowLimit);
  }

  /** @param {Value} state @param {string} eventId @param {string} role @param {string|null} turn @param {Value} ev @param {Value} [meta] */
  #event(state, eventId, role, turn, ev, meta = {}) {
    if (state.events.some((/** @type {Value} */ item) => item.id === eventId)) return;
    const time = Math.max(Date.now(), state.clock + 1); state.clock = time;
    const record = { role: 'session', content: { id: eventId, time, role, ...(turn ? { turn } : {}), ev }, meta: { sentFrom: 'noninvasive-observer', ...meta } };
    state.events.push({ id: eventId, localId: `${eventId}-observed`, ciphertext: encryptRecord(record, this.#key), sent: false });
  }
  /** @param {Value} state @param {string} turnId */
  #turnStart(state, turnId) {
    let turn = state.turns.find((/** @type {Value} */ item) => item.id === turnId);
    if (!turn) { turn = { id: turnId, started: false, ended: null }; state.turns.push(turn); }
    if (!turn.started) { this.#event(state, 'ni' + hash([this.bindingId, turnId, 'turn-start']).slice(0, 28), 'agent', turnId, { t: 'turn-start' }); turn.started = true; }
  }
  /** @param {Value} state @param {Value} row @param {Value} tool */
  #tool(state, row, tool) {
    if (!tool.id) return;
    let entry = state.rows.find((/** @type {Value} */ item) => item.id === `tool:${tool.id}`);
    if (!entry) {
      entry = { id: `tool:${tool.id}`, revision: 0, output: null, terminal: null, eventIds: [] }; state.rows.push(entry); this.#turnStart(state, row.turnId);
      const startId = 'ni' + hash([this.bindingId, tool.id, 'tool-start']).slice(0, 28); this.#event(state, startId, 'agent', row.turnId, { t: 'tool-call-start', call: tool.id, name: tool.name ?? 'Tool', title: tool.name ?? 'Tool', description: '', args: object(tool.arguments) ? tool.arguments : {} }); entry.eventIds.push(startId);
    }
    const status = terminal(tool.status), output = typeof tool.output === 'string' ? tool.output : '';
    if (output === entry.output && status === entry.terminal) return;
    if (status && !entry.terminal) {
      const eventId = 'ni' + hash([this.bindingId, tool.id, 'tool-end', this.#mac(output), status]).slice(0, 28);
      this.#event(state, eventId, 'agent', row.turnId, { t: 'tool-call-end', call: tool.id, result: output, isError: status === 'failed' }); entry.eventIds.push(eventId);
    } else if (output) {
      entry.revision++; state.projectionStatus = this.#options.supportsNativeProjection ? 'ready' : 'resync-required';
      const eventId = 'ni' + hash([this.bindingId, tool.id, 'tool-output', entry.revision, this.#mac(output)]).slice(0, 28);
      this.#event(state, eventId, 'agent', row.turnId, { t: 'native-row-upsert', sourceRowId: row.id, role: 'tool', text: '', tools: [{ id: tool.id, name: tool.name, output, status: tool.status }], revision: entry.revision, replaceIds: [] }); entry.eventIds.push(eventId);
    }
    entry.output = output; entry.terminal = status;
  }

  async #flushEvents() {
    if (this.#flushFlight) return this.#flushFlight;
    this.#flushFlight = (async () => {
      while (!this.#closed) {
        const pending = this.#state.events.filter((/** @type {Value} */ event) => !event.sent).slice(0, 50);
        if (!pending.length) return;
        if (this.#closed) return;
        const records = pending.map((/** @type {Value} */ event) => {
          const record = decryptRecord(event.ciphertext, this.#key);
          if (!record) throw new BridgeError('event-plan-decryption-failed', 'The fixed Happy event plan could not be decoded.');
          return { localId: event.localId, record };
        });
        if (typeof this.#options.transport.publishBatch === 'function') await this.#options.transport.publishBatch(records);
        else for (const record of records) await this.#options.transport.publish(record.localId, record.record);
        const ids = new Set(pending.map((/** @type {Value} */ event) => event.id));
        await this.#mutate(state => { for (const event of state.events) if (ids.has(event.id)) event.sent = true; });
      }
    })().finally(() => { this.#flushFlight = null; }); return this.#flushFlight;
  }

  /** @param {Value} view @param {string|null} epoch */
  #requestMap(view, epoch) {
    /** @type {Value[]} */ const mappings = [];
    for (const request of view.requests ?? []) {
      if (!request.operable || request.requestId == null) continue;
      const key = 'rq' + hash([this.bindingId, request.kind, request.requestId]).slice(0, 28);
      mappings.push({ key, type: 'request', kind: request.kind, requestId: request.requestId, epoch, request: structuredClone(request) });
    }
    // 旧实现把所有历史未答问题放到底栏；最近一轮答完后仍会催促早先的解锁/授权问题。
    for (const question of pendingNativeAsyncQuestions(view)) {
      mappings.push({ key: 'cq' + hash([this.bindingId, question.questionItemId]).slice(0, 28), type: 'async-question', questionItemId: question.questionItemId, epoch, question: structuredClone(question) });
    }
    return mappings;
  }
  /** @param {Value} view @param {string|null} epoch @param {boolean} lease */
  async #publishMetadata(view, epoch, lease) {
    const sessionControl = available(view) && view.kind !== 'window' && this.#options.sourceIdentity.app === 'codex' && epoch !== null && lease;
    const rpcMethods = sessionControl ? ['abort', 'permission', 'communication', 'bridge-receipt'] : ['bridge-receipt'];
    const windowControl = available(view) && view.kind === 'window' && epoch !== null && lease;
    if (windowControl) rpcMethods.push('window-control');
    if (lease && this.#options.sourceIdentity.app === 'codex' && this.#options.sourceIdentity.hostId === 'local') rpcMethods.push('open-desktop');
    if (sessionControl && this.#options.adapter.supportsNativeModelSettings === true) rpcMethods.push('codex-controls-read', 'codex-controls-update');
    if (this.#controlsEpoch !== epoch) { this.#nativeControls = null; this.#controlsEpoch = epoch; this.#controlsReadAt = 0; }
    const catalogMatches = !view.nativeControlsCurrent || !!(view.nativeControlsCurrent.modelProvider === this.#nativeControls?.model?.current?.modelProvider &&
      this.#nativeControls?.model?.models?.some((/** @type {Value} */ m) => m.id === view.nativeControlsCurrent.model));
    const nativeControls = this.#nativeControls ? { ...this.#nativeControls, model: { ...this.#nativeControls.model, available: sessionControl && catalogMatches && this.#nativeControls.model?.available === true,
      ...(view.nativeControlsCurrent ? { current: view.nativeControlsCurrent } : {}) } } : undefined;
    if (sessionControl && this.#options.adapter.supportsNativeModelSettings === true) void this.#refreshControls(epoch).catch(() => {});
    const modelSelection = sessionControl && nativeControls?.model?.available === true;
    const caps = { abort: sessionControl && typeof view.currentTurnId === 'string', attachments: { enabled: false, maxBytes: 0, mediaTypes: [] }, files: { browse: false, read: false, search: false, write: false }, messageReceipts: true, modelSelection, reasoningSelection: modelSelection, permissionModeSelection: false, resume: false, rpcMethods, shell: false, steering: sessionControl, windowControl };
    const bridge = { ...this.#metadata.bridge, version: 1, source: { ...this.#options.sourceIdentity, runtimeGeneration: epoch, windowGeneration: this.#options.sourceIdentity.windowGeneration ?? null }, currentTurnId: view.currentTurnId ?? null, controlMode: view.kind === 'window' ? 'window' : 'session', sourceStatus: this.#state.sourceStatus, projectionStatus: this.#state.projectionStatus };
    await this.#options.transport.updateMetadata((/** @type {Value} */ current) => ({ ...this.#metadata, ...current, bridge, capabilities: caps,
      ...(nativeControls ? { nativeControls } : current?.nativeControls ? { nativeControls: { ...current.nativeControls, model: { ...current.nativeControls.model, available: false } } } : {}) }));
    // Happy 的在线状态由 session-alive 驱动；只更新 metadata 会让实际可控的原 owner 被手机判为离线。
    if (this.#state.sourceStatus === 'connected') this.#options.transport.keepAlive?.(typeof view.currentTurnId === 'string');
    const requests = /** @type {Value} */ ({}), communications = /** @type {Value} */ ({});
    for (const mapping of this.#state.requestMap) {
      if (mapping.type === 'async-question') communications[mapping.key] = { kind: 'form', title: mapping.question.title, form: { questions: [{ id: 'answer', header: '', question: mapping.question.title, options: (mapping.question.options ?? []).map((/** @type {string} */ label) => ({ label })), allowCustom: true, required: true }] } };
      else if (mapping.kind === 'user-input' && !(mapping.request.questions ?? []).some((/** @type {Value} */ question) => question.secret)) communications[mapping.key] = { kind: 'form', title: 'Native question', form: { questions: (mapping.request.questions ?? []).map((/** @type {Value} */ question) => ({ id: question.id, header: question.header ?? '', question: question.question ?? '', options: question.options ?? [], allowCustom: true, required: true })) } };
      else requests[mapping.key] = { tool: mapping.request.command ?? mapping.kind, arguments: { ...mapping.request, nativeRequestKey: mapping.key, acceptSupported: mapping.request.acceptSupported !== false }, toolUseId: mapping.request.itemId ?? undefined };
    }
    const window = view.kind === 'window' ? { controls: view.controls ?? [], captureStamp: view.captureStamp ?? null, imageRef: view.imageRef ?? null, bounds: view.bounds ?? view.captureStamp?.bounds ?? null,
      runtimeGeneration: view.runtimeGeneration ?? epoch, windowGeneration: view.windowGeneration ?? null, textInputAvailable: view.textInputAvailable ?? false,
      semanticControlAvailable: view.semanticControlAvailable ?? false, coordinateControlAvailable: view.coordinateControlAvailable ?? false,
      contentFreshness: view.contentFreshness ?? 'ax-observation-only' } : undefined;
    await this.#options.transport.updateAgentState((/** @type {Value} */ current) => ({ ...current, requests, communications, ...(window ? { windowObservation: window } : {}) }));
  }

  processInbox() {
    if (this.#closed || this.#retiring) return Promise.resolve();
    if (this.#inputFlight) { this.#inputDirty = true; return this.#inputFlight; }
    this.#inputFlight = (async () => {
      do {
      this.#inputDirty = false;
      for (const incoming of this.#options.transport.listInbox()) {
        if (this.#closed) return;
        if (incoming.publishedByThisTransport || incoming.record?.role !== 'user') { await this.#options.transport.ackInbox(incoming.id); continue; }
        await this.#message(incoming); await this.#options.transport.ackInbox(incoming.id);
      }
      await this.#flushEvents();
      } while (this.#inputDirty && !this.#closed);
    })().finally(() => { this.#inputFlight = null; }); return this.#inputFlight;
  }

  /** @param {Value} incoming */
  async #message(incoming) {
    const record = incoming.record;
    if (record.content?.type !== 'text' || typeof record.content.text !== 'string' || !record.content.text.trim()) { await this.#mutate(state => this.#rejectEvent(state, incoming.id, 'invalid-input')); return; }
    const key = `message:${incoming.localId ?? incoming.id}`, existing = this.#state.commands.find((/** @type {Value} */ command) => command.key === key);
    const inputDigest = this.#mac(record.content.text);
    if (existing) { if (existing.inputDigest !== inputDigest) throw new BridgeError('command-conflict', 'The stable Happy input identity was reused for other text.'); await this.#execute(existing); return; }
    const view = this.#view, action = typeof view.currentTurnId === 'string' ? 'steer' : 'send', epoch = await this.#epoch();
    const plan = { key, id: 'hc' + hash([this.bindingId, incoming.localId ?? incoming.id, action]).slice(0, 62), origin: 'message', serverId: incoming.id, localId: incoming.localId, inputDigest, action,
      payload: { text: record.content.text }, epoch, expectedTurnId: view.currentTurnId ?? null, state: 'prepared', admission: null };
    await this.#mutate(state => state.commands.push(plan)); await this.#execute(plan);
  }

  /** @param {Value} plan @returns {Promise<Value>} */
  #execute(plan) {
    if (this.#commandFlights.has(plan.id)) return /** @type {Promise<Value>} */ (this.#commandFlights.get(plan.id));
    const flight = this.#executePlan(plan).finally(() => { this.#commandFlights.delete(plan.id); }); this.#commandFlights.set(plan.id, flight); return flight;
  }
  /** @param {Value} plan */
  async #executePlan(plan) {
    const saved = this.#state.commands.find((/** @type {Value} */ item) => item.id === plan.id), prior = this.#options.receipts.query(this.receiptScope, plan.id);
    if (saved.state !== 'prepared' || prior) {
      if (prior) {
        // query只提供状态，不能校验payload摘要；重复run仅用于既有receipt校验，永不重新调用native。
        await this.#options.receipts.run(this.receiptScope, plan.id, { action: plan.action, payload: plan.payload, epoch: plan.epoch, expectedTurnId: plan.expectedTurnId }, async () => { throw new BridgeError('delivery-unknown', 'The previous native receipt disappeared; no native redispatch was attempted.'); });
      }
      await this.#mutate(state => { const command = state.commands.find((/** @type {Value} */ item) => item.id === plan.id); if (prior && ['running', 'complete', 'failed', 'unknown'].includes(prior.status)) { command.state = prior.status; command.result = prior.result; command.error = prior.error; command.nativeCause = nativeCauseCode(prior.nativeCause); if (prior.result?.nativeAdmission?.confirmed) command.admission = prior.result.nativeAdmission; } else if (command.state === 'dispatching') { command.state = 'unknown'; command.error = 'unconfirmed-prior-dispatch'; } this.#reconcileCommands(state, this.#view); this.#receiptEvent(state, command); });
      return this.#mustReceipt(plan.id);
    }
    await this.#mutate(state => { const command = state.commands.find((/** @type {Value} */ item) => item.id === plan.id); command.state = 'dispatching'; });
    const receipt = await this.#options.receipts.run(this.receiptScope, plan.id, { action: plan.action, payload: plan.payload, epoch: plan.epoch, expectedTurnId: plan.expectedTurnId }, async () => {
      await this.#guard(plan);
      let result;
      try { result = await this.#options.adapter.command(this.nativeId, plan.action, structuredClone(plan.payload), plan.id, { expectedGeneration: plan.epoch }); }
      catch (error) {
        if (error instanceof BridgeError && SAFE_NATIVE_ERRORS.has(error.code)) throw error;
        if (error instanceof BridgeError && /** @type {BridgeError & {effectMayHaveOccurred?:boolean}} */ (error).effectMayHaveOccurred === false) throw error;
        const unknown = new BridgeError('delivery-unknown', 'The native command may have occurred; it will not be replayed.');
        const cause = error instanceof BridgeError ? nativeCauseCode(/** @type {BridgeError & {nativeCause?:unknown}} */ (error).nativeCause) : undefined;
        if (cause) Object.assign(unknown, { nativeCause: cause });
        throw unknown;
      }
      if (plan.action === 'update-settings' && result.applied === true) {
        try {
          await this.#mutate(state => {
            const command = state.commands.find((/** @type {Value} */ item) => item.id === plan.id);
            command.nativeSettingsUpdate = { applied: true, model: plan.payload.model, reasoningEffort: plan.payload.reasoningEffort, ownerEpoch: plan.epoch };
          });
        } catch { throw new BridgeError('delivery-unknown', 'The applied original settings acknowledgment could not be checkpointed; no update replay is allowed.'); }
        if (result.settingsReadbackConfirmed !== true) throw new BridgeError('delivery-unknown', 'The original settings were applied, but readback is unconfirmed; this update will not be replayed.');
      }
      if (['send', 'steer'].includes(plan.action)) {
        const evidence = await this.#waitAdmission(plan, result);
        if (!evidence) throw new BridgeError('delivery-unknown', 'Native acknowledgment has no verified input admission; it will not be resent.');
        return { ...result, nativeAdmission: evidence };
      }
      return result;
    });
    await this.#mutate(state => { const command = state.commands.find((/** @type {Value} */ item) => item.id === plan.id); command.state = receipt.status; command.result = receipt.result; command.error = receipt.error; command.nativeCause = nativeCauseCode(receipt.nativeCause); command.admission = receipt.result?.nativeAdmission ?? command.admission; this.#reconcileCommands(state, this.#view); this.#receiptEvent(state, command); });
    return this.#mustReceipt(plan.id);
  }

  /** @param {Value} plan @param {Value} result */
  async #waitAdmission(plan, result) {
    if (await this.#epoch() !== plan.epoch) return null;
    const explicit = result.admitted === true || result.admissionConfirmed === true;
    if (explicit) return { confirmed: true, turnId: result.turnId ?? null, messageId: result.messageId ?? null, queued: result.queued === true };
    const deadline = Date.now() + (this.#options.admissionTimeoutMs ?? 5000);
    do {
      const row = observedInputRow(this.#view, plan.id, result.messageId);
      if (row) return { confirmed: true, turnId: row.turnId ?? null, messageId: row.id, queued: false };
      if (await this.#epoch() !== plan.epoch) return null;
      try { this.#view = viewOf(await this.#options.adapter.snapshot(this.nativeId)); } catch { return null; }
      if (Date.now() >= deadline) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    } while (!this.#closed);
    return null;
  }
  /** @param {Value} state @param {Value} view */
  #reconcileCommands(state, view) {
    for (const command of state.commands) {
      const questionReply = command.origin === 'rpc' && command.action === 'answer-question';
      if (!(command.origin === 'message' && ['send', 'steer'].includes(command.action) || questionReply)
        || !['dispatching', 'running', 'unknown', 'complete'].includes(command.state)) continue;
      const row = observedInputRow(view, command.id, command.result?.messageId);
      if (!row || state.epoch !== command.epoch || questionReply && row.inputStatus !== 'accepted') continue;
      command.admission = { confirmed: true, turnId: row.turnId ?? null, messageId: row.id, queued: false }; command.resolvedByObservation = true; this.#receiptEvent(state, command);
    }
  }
  /** @param {Value} state @param {Value} command */
  #receiptEvent(state, command) {
    if (command.origin !== 'message' || !command.serverId) return;
    if (command.admission?.confirmed && command.admission.turnId) {
      const eventId = 'hr' + hash([this.bindingId, command.id, 'accepted']).slice(0, 28);
      this.#event(state, eventId, 'agent', command.admission.turnId, { t: 'user-message-accepted', id: eventId, ref: command.serverId, runId: command.admission.turnId });
    } else if (command.state === 'failed') this.#rejectEvent(state, command.serverId, command.error ?? 'native-rejected');
    else if (command.state === 'unknown' && !command.admission?.confirmed) {
      const eventId = 'hr' + hash([this.bindingId, command.id, 'delivery-unknown']).slice(0, 28);
      // 未知结果不能伪装“已接受/失败”；发布关联原消息的非终态提示，晚到原生身份可继续确认。
      this.#event(state, eventId, 'agent', null, { t: 'user-message-delivery-unknown', ref: command.serverId, commandId: command.id });
    }
  }
  /** @param {Value} state @param {string} serverId @param {string} reason */
  #rejectEvent(state, serverId, reason) { const eventId = 'hr' + hash([this.bindingId, serverId, 'rejected']).slice(0, 28); this.#event(state, eventId, 'agent', null, { t: 'user-message-rejected', ref: serverId, reason }); }
  /** @param {string} command */
  #publicReceipt(command) { const value = this.#state.commands.find((/** @type {Value} */ item) => item.id === command); return value ? { id: value.id, commandId: value.id, target: this.#receiptTarget(value), status: value.admission?.confirmed ? 'complete' : value.state,
    nativeReceiptStatus: value.resolvedBySettingsObservation ? this.#options.receipts.query(this.receiptScope, value.id)?.status ?? value.state : value.state,
    admission: value.admission ?? null, result: value.result ?? null, error: value.error ?? null, ...(nativeCauseCode(value.nativeCause) ? { nativeCause: nativeCauseCode(value.nativeCause) } : {}) } : null; }
  /** Nonsecret logical target lets another question proceed without replaying this operation. @param {Value} command */
  #receiptTarget(command) {
    if (typeof command.rpcTarget === 'string') return command.rpcTarget;
    if (command.action === 'answer-question' && typeof command.payload?.questionItemId === 'string') {
      const key = 'cq' + hash([this.bindingId, command.payload.questionItemId]).slice(0, 28);
      return rpcTarget('communication', { id: key });
    }
    if (command.action === 'interrupt') return rpcTarget('abort', { turnId: command.payload?.turnId });
    return undefined;
  }
  /** @param {string} command @returns {Value} */
  #mustReceipt(command) { const receipt = this.#publicReceipt(command); if (!receipt) throw new BridgeError('missing-command-plan', 'The saved native command plan is missing.'); return receipt; }
  /** @param {unknown} params */
  async #receiptQuery(params) {
    if (!object(params)) throw new BridgeError('invalid-command-id', 'A receipt commandId is required.');
    const key = commandId(params.commandId), command = this.#state.commands.find((/** @type {Value} */ item) => item.id === key);
    if (command?.nativeSettingsUpdate?.applied === true && command.state === 'unknown') {
      try { const controls = await this.#options.adapter.command(this.nativeId, 'read-controls', {}, key, { expectedGeneration: command.epoch }); await this.#confirmSettingsObservation(command, controls); } catch { /* A failed read cannot trigger a second write. */ }
    }
    return { ok: true, receipt: this.#publicReceipt(key) ?? this.#options.receipts.query(this.receiptScope, key) ?? null };
  }
  /** @param {Value} command @param {Value} controls */
  async #confirmSettingsObservation(command, controls) {
    const evidence = command.nativeSettingsUpdate, current = controls.model?.current;
    if (this.#closed || command.state !== 'unknown' || evidence?.applied !== true || evidence.ownerEpoch !== command.epoch ||
        !await this.#lease() || await this.#epoch() !== command.epoch || current?.model !== evidence.model || current?.reasoningEffort !== evidence.reasoningEffort) return;
    await this.#mutate(state => {
      const saved = state.commands.find((/** @type {Value} */ item) => item.id === command.id);
      if (!saved || saved.state !== 'unknown' || saved.nativeSettingsUpdate?.applied !== true) return;
      saved.state = 'complete'; saved.resolvedBySettingsObservation = true; saved.error = null;
      saved.result = { acknowledged: true, applied: true, settingsReadbackConfirmed: true, controls };
    });
    this.#nativeControls = controls; this.#controlsReadAt = Date.now();
    await this.#options.transport.updateMetadata((/** @type {Value} */ current) => ({ ...current, nativeControls: { ...controls, model: { ...controls.model, available: this.#state.sourceStatus === 'connected' && controls.model?.available === true } },
      capabilities: { ...current.capabilities, modelSelection: this.#state.sourceStatus === 'connected' && controls.model?.available === true, reasoningSelection: this.#state.sourceStatus === 'connected' && controls.model?.available === true } }));
  }

  /** Read model controls independently of transcript projection; this never starts a turn.
   * @param {string|null} epoch @param {boolean} [force] @returns {Promise<Value>} */
  #refreshControls(epoch, force = false) {
    if (this.#options.adapter.supportsNativeModelSettings !== true) return Promise.reject(new BridgeError('unsupported-action', 'This source has no original model settings contract.'));
    if (this.#controlsFlight) return this.#controlsFlight;
    if (!force && this.#nativeControls && this.#controlsEpoch === epoch && Date.now() - this.#controlsReadAt < 10000) return Promise.resolve(this.#nativeControls);
    const read = (async () => {
      const revision = this.#controlsRevision;
      if (this.#closed || epoch === null || !await this.#lease() || this.#options.sourceIdentity.app !== 'codex') throw new BridgeError('source-unavailable', 'The original settings owner is unavailable.');
      const controls = await this.#options.adapter.command(this.nativeId, 'read-controls', {}, 'controls-read-' + randomUUID(), { expectedGeneration: epoch });
      if (this.#closed || !await this.#lease() || await this.#epoch() !== epoch) throw new BridgeError('source-epoch-changed', 'The original settings owner changed during read.');
      // 设置更新已开始时，旧只读结果不能在 RPC 确认后覆盖用户的新选择。
      if (revision !== this.#controlsRevision) { this.#controlsReadAt = 0; return this.#nativeControls ?? controls; }
      this.#nativeControls = controls; this.#controlsEpoch = epoch; this.#controlsReadAt = Date.now();
      for (const command of this.#state.commands) if (command.state === 'unknown' && command.nativeSettingsUpdate?.applied === true) await this.#confirmSettingsObservation(command, controls);
      await this.#options.transport.updateMetadata((/** @type {Value} */ current) => ({ ...current, nativeControls: { ...controls, model: { ...controls.model, available: this.#state.sourceStatus === 'connected' && controls.model?.available === true } },
        capabilities: { ...current.capabilities, modelSelection: this.#state.sourceStatus === 'connected' && controls.model?.available === true, reasoningSelection: this.#state.sourceStatus === 'connected' && controls.model?.available === true } }));
      return controls;
    })().finally(() => { if (this.#controlsFlight === read) this.#controlsFlight = null; });
    this.#controlsFlight = read; return read;
  }
  /** @param {unknown} params */
  async #readControlsRpc(params) {
    if (!object(params) || Object.keys(params).some(key => key !== 'commandId')) throw new BridgeError('invalid-rpc-payload', 'A controls read accepts only its stable command identity.');
    const key = commandId(params.commandId), epoch = await this.#epoch();
    const receipt = await this.#options.receipts.run(this.receiptScope, key, { action: 'read-controls', epoch }, () => this.#refreshControls(epoch, true));
    return this.#rpcReply(receipt);
  }

  /** @param {string} method @param {unknown} params */
  async #rpc(method, params) {
    if (!object(params)) throw new BridgeError('invalid-rpc-payload', 'A typed native RPC payload is required.');
    const key = commandId(params.commandId), existing = this.#state.commands.find((/** @type {Value} */ item) => item.id === key);
    const requestDigest = this.#mac({ method, params });
    if (existing) {
      // 原摘要遗漏 method 会把 open-desktop 回执误当 abort 成功；旧计划只能按已冻结动作识别原接口后迁移。
      const originalMethod = existing.rpcMethod ?? (existing.action === 'interrupt' ? 'abort' : existing.action === 'open-desktop' ? 'open-desktop'
        : existing.action === 'answer-question' || existing.action === 'approval' && existing.payload?.kind === 'user-input' ? 'communication'
          : existing.action === 'approval' ? 'permission' : null);
      if (originalMethod !== method || existing.requestDigest !== (existing.rpcMethod ? requestDigest : this.#mac(params))) throw new BridgeError('command-conflict', 'The stable RPC id was reused for another request or method.');
      if (!existing.rpcMethod) await this.#mutate(state => { const saved = state.commands.find((/** @type {Value} */ item) => item.id === key); saved.rpcMethod = method; saved.requestDigest = requestDigest; });
      if (existing.resolvedBySettingsObservation && existing.state === 'complete') return this.#rpcReply(this.#mustReceipt(key));
      return this.#rpcReply(await this.#execute(existing));
    }
    let plan;
    const epoch = await this.#epoch();
    if (method === 'window-control') {
      if (!['activate', 'click', 'press', 'type', 'key', 'scroll'].includes(params.action) || !object(params.payload)) throw new BridgeError('unsupported-action', 'An explicit supported window action and typed payload are required.');
      const keys = ['captureStamp', 'runtimeGeneration', 'windowGeneration', 'nodeId', 'text', 'key', 'x', 'y', 'deltaY'];
      if (Object.keys(params.payload).some(key => !keys.includes(key))) throw new BridgeError('invalid-payload', 'Window control cannot add arbitrary native fields.');
      plan = { action: params.action, payload: structuredClone(params.payload), expectedTurnId: null, windowControl: true };
    } else if (method === 'open-desktop') {
      plan = { action: 'open-desktop', payload: {}, expectedTurnId: null };
    } else if (method === 'abort') {
      const turnId = id(params.turnId, 'Original foreground turn');
      plan = { action: 'interrupt', payload: { turnId }, expectedTurnId: turnId };
    } else if (method === 'codex-controls-update') {
      if (this.#options.adapter.supportsNativeModelSettings !== true) throw new BridgeError('unsupported-action', 'This source has no original model settings contract.');
      const keys = ['commandId', 'model', 'reasoningEffort', 'expectedModel', 'expectedReasoningEffort'];
      if (Object.keys(params).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(params, key)) ||
          typeof params.model !== 'string' || !params.model.trim() || typeof params.expectedModel !== 'string' || !params.expectedModel.trim() ||
          params.reasoningEffort !== null && typeof params.reasoningEffort !== 'string' || params.expectedReasoningEffort !== null && typeof params.expectedReasoningEffort !== 'string') throw new BridgeError('invalid-settings', 'A model choice and the original settings snapshot are required.');
      plan = { action: 'update-settings', payload: { model: params.model, reasoningEffort: params.reasoningEffort, expectedModel: params.expectedModel, expectedReasoningEffort: params.expectedReasoningEffort }, expectedTurnId: null };
      this.#controlsRevision++;
    } else {
      const mapping = this.#state.requestMap.find((/** @type {Value} */ item) => item.key === params.id);
      if (!mapping || mapping.epoch !== epoch) throw new BridgeError('stale-approval', 'The original pending request mapping is unavailable.');
      if (method === 'permission') plan = this.#permissionPlan(mapping, params);
      else plan = this.#communicationPlan(mapping, params);
    }
    const full = { ...plan, id: key, key: `rpc:${key}`, origin: 'rpc', rpcMethod: method, rpcTarget: rpcTarget(method, params), state: 'prepared', epoch, requestDigest, admission: null };
    await this.#mutate(state => state.commands.push(full));
    const result = await this.#execute(full);
    if (method === 'codex-controls-update' && result.status === 'complete') {
      if (result.result?.controls) { this.#nativeControls = result.result.controls; this.#controlsReadAt = 0; }
      void this.#refreshControls(epoch, true).catch(() => {});
    }
    return this.#rpcReply(result);
  }
  /** @param {Value} result */
  #rpcReply(result) {
    if (result.status !== 'complete') { const error = new BridgeError(result.error ?? (result.status === 'failed' ? 'native-rejected' : 'delivery-unknown'), 'The native operation could not be confirmed.'); Object.assign(error, { effectMayHaveOccurred: result.status !== 'failed', receipt: result, ...(nativeCauseCode(result.nativeCause) ? { nativeCause: nativeCauseCode(result.nativeCause) } : {}) }); throw error; }
    return { ok: true, receipt: result };
  }

  /** @param {Value} mapping @param {Value} params */
  #permissionPlan(mapping, params) {
    if (mapping.type !== 'request' || params.mode != null || (params.allowTools?.length ?? 0) || params.updatedInput != null || params.decision === 'approved_for_session') throw new BridgeError('unsupported-permission-mode', 'This native permission mode or input rewrite is unsupported.');
    const request = mapping.request, requestLink = { type: 'request', kind: mapping.kind, requestId: mapping.requestId, digest: this.#mac(mapping.request) };
    if (['command', 'file'].includes(mapping.kind)) {
      const decision = params.decision === 'abort' ? 'cancel' : params.approved === true ? 'accept' : params.approved === false ? 'decline' : null;
      if (!decision || decision === 'accept' && request.acceptSupported === false || request.allowedActions && !request.allowedActions.includes(decision)) throw new BridgeError('unsupported-approval', 'The requested native permission action is unavailable.');
      return { action: 'approval', payload: { kind: mapping.kind, requestId: mapping.requestId, decision }, request: requestLink };
    }
    if (mapping.kind === 'permissions' && typeof params.approved === 'boolean') {
      const scope = params.scope ?? 'turn';
      if (!['turn', 'session'].includes(scope) || !request.grantScopes?.includes(scope)) throw new BridgeError('unsupported-permission-mode', 'The requested native permission scope is unavailable.');
      const response = params.approved ? { permissions: request.requestedPermissions, scope } : { permissions: {}, scope };
      return { action: 'approval', payload: { kind: 'permissions', requestId: mapping.requestId, response }, request: requestLink };
    }
    if (mapping.kind === 'elicitation' && object(params.response)) return { action: 'approval', payload: { kind: 'elicitation', requestId: mapping.requestId, response: params.response }, request: requestLink };
    throw new BridgeError('unsupported-approval', 'Use the verified native question/form channel for this request.');
  }
  /** @param {Value} mapping @param {Value} params */
  #communicationPlan(mapping, params) {
    if (params.kind != null && params.kind !== 'form') throw new BridgeError('unsupported-communication', 'This native communication requires the matching form kind.');
    if (params.status !== 'answered' || !object(params.answers)) throw new BridgeError('unsupported-communication', 'This native question requires an explicit answer.');
    const answerText = (/** @type {Value} */ answer) => [...(Array.isArray(answer.options) ? answer.options.filter((/** @type {unknown} */ text) => typeof text === 'string') : []), ...(typeof answer.custom === 'string' && answer.custom.trim() ? [answer.custom] : [])];
    if (mapping.type === 'async-question') {
      if (Object.keys(params.answers).length !== 1 || !object(params.answers.answer)) throw new BridgeError('invalid-answer-identity', 'Answer the original asynchronous question identity.');
      const answer = answerText(params.answers.answer).join('\n'); if (!answer.trim()) throw new BridgeError('invalid-answer', 'A nonempty original question answer is required.');
      return { action: 'answer-question', payload: { questionItemId: mapping.questionItemId, answer }, request: { type: 'async-question', questionItemId: mapping.questionItemId } };
    }
    if (mapping.kind !== 'user-input' || (mapping.request.questions ?? []).some((/** @type {Value} */ question) => question.secret)) throw new BridgeError('unsupported-communication', 'This native communication is not supported by the Happy form.');
    const questions = mapping.request.questions ?? [], expected = questions.map((/** @type {Value} */ question) => question.id);
    if (Object.keys(params.answers).length !== expected.length || Object.keys(params.answers).some(key => !expected.includes(key))) throw new BridgeError('invalid-answer-identity', 'Answer ids must match the pending native questions.');
    /** @type {Value} */ const answers = {};
    for (const question of questions) { if (!object(params.answers[question.id])) throw new BridgeError('invalid-answer', 'An answer object is required.'); answers[question.id] = { answers: answerText(params.answers[question.id]) }; }
    return { action: 'approval', payload: { kind: 'user-input', requestId: mapping.requestId, response: { answers } }, request: { type: 'request', kind: 'user-input', requestId: mapping.requestId, digest: this.#mac(mapping.request) } };
  }

  /** Atomically retire an idle CodeLight observer; unknown history remains durable.
   * @returns {Promise<boolean>} */
  tryCloseIfIdle() {
    if (this.#closeFlight) return this.#closeFlight.then(() => true);
    // 同一同步片段先封住入口再复查；忙时恢复入口，不能用检查后的异步 close 留出 admission 窗口。
    this.#retiring = true;
    if (this.#unsafeToRetire()) { this.#retiring = false; return Promise.resolve(false); }
    return this.close().then(() => true);
  }
  #unsafeToRetire() {
    if (this.#starting || this.#operations.size || this.#commandFlights.size || this.#inputFlight || this.#attachFlight ||
      this.#projectFlight || this.#pendingView || this.#flushFlight || this.#controlsFlight ||
      this.#state.commands?.some((/** @type {Value} */ command) => ['prepared', 'dispatching', 'running'].includes(command.state)) ||
      this.#state.events?.some((/** @type {Value} */ event) => !event.sent)) return true;
    // 未知 transport 状态不是空队列；当前实现提供同步状态，退休后 late capture 仍由原 close 保存。
    try {
      const value = this.#options.transport.status();
      return !Number.isSafeInteger(value.pendingInbox) || value.pendingInbox !== 0 || !Number.isSafeInteger(value.pendingOutbox) || value.pendingOutbox !== 0;
    } catch { return true; }
  }
  close() {
    if (!this.#closeFlight) {
      this.#closed = true; this.#retiring = true;
      this.#closeFlight = Promise.resolve().then(() => this.#close());
    }
    return this.#closeFlight;
  }
  async #close() {
    this.#release?.(); this.#release = null;
    if (this.#retryTimer) clearInterval(this.#retryTimer);
    for (const release of this.#rpcReleases.splice(0)) release();
    await Promise.allSettled([this.#startFlight, this.#attachFlight, this.#projectFlight, this.#inputFlight, this.#flushFlight, this.#controlsFlight, ...this.#operations, ...this.#commandFlights.values()]); await this.#ioTail;
    this.#releaseState();
  }
  #releaseState() { if (this.#ownsState) { owners.delete(this.statePath); this.#ownsState = false; } }
}
