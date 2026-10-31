import { CodexIpcAdapter } from './codex-ipc.mjs';
import { pendingNativeAsyncQuestions } from '../native-question-scope.mjs';
import { BridgeError } from '../errors.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { writePrivateJson } from '../private-json.mjs';
import { validateNativeResponse, validateFormResponse, validateQuestionResponse, validatePermissionSubset, supportsForm, prepareNativeSchemas, supportsNativePermissions } from './codex-response-schema.mjs';

/** @typedef {Record<string, any>} Value */
/** @typedef {{id:string,role:string,text:string,tools:Value[],turnId:string|null,status:string|null,at:number|null,asyncQuestions?:Value[],commandId?:string}} Row */
/** @typedef {{rows:Row[],currentTurnId:string|null,latestTurnId?:string|null,status:string,requests:Value[],revision:number|null,contentStamp?:string,ownerGeneration?:string,nativeControlsCurrent?:Value}} View */
/** @typedef {{resolve:(view:View)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}} Waiter */
/** @typedef {{sourceId:string,row:Row}} Candidate */
/** @typedef {{source:Value,index:number,context:string,candidates:Candidate[],items:Map<Value,{index:number,candidate:Candidate|null}>,dependencies:unknown[],silent:boolean}} TurnProjection */
/** @typedef {{projectedTurns:number,projectedItems:number,serializedRowBytes:number}} ProjectionWork */
/** @typedef {{state:Value,turns:Value[],entries:TurnProjection[],dependencies:unknown[],questions:Map<string,Value>,answers:Map<string,string>,rows:Row[],rowsDigest:string,rowDigests:WeakMap<Row,string>,currentTurnId:string|null,active:Value|null,silentTurn:Value|null,requests:Value[],work:ProjectionWork}} Projection */
/** @typedef {{id:string,refs:number,generation:number,ownerGeneration:string|null,state:Value|null,view:View|null,projection:Projection|null,revision:number|null,callbacks:Set<(view:View)=>void>,waiters:Set<Waiter>,releaseNative:(()=>void)|null,starting:Promise<void>|null,recovering:Promise<void>|null,retry:ReturnType<typeof setTimeout>|null,refreshTimer:ReturnType<typeof setTimeout>|null,refreshInFlight:boolean,incompleteRefreshes:number,refreshTurn:string|null}} Session */

/** Safe phone-facing projection of the existing native desktop owner. */
export class CodexBackend {
  supportsNativeModelSettings = true;
  /** @param {{ipc?:CodexIpcAdapter,waitTimeoutMs?:number,snapshotRefreshMs?:number,nativeErrorThread?:string,nativeErrorFile?:string,openDesktop?:((uri:string)=>Promise<unknown>),loadModelCatalog?:(provider:string|null,currentModel:string)=>Promise<Value>}} [options] */
  constructor(options = {}) {
    this.ipc = options.ipc ?? new CodexIpcAdapter();
    this.openDesktop = options.openDesktop ?? openLocalCodexDesktop;
    this.loadModelCatalog = options.loadModelCatalog ?? loadNativeCodexModelCatalog;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 15_000;
    this.snapshotRefreshMs = options.snapshotRefreshMs ?? 1000;
    if (!Number.isSafeInteger(this.snapshotRefreshMs) || (this.snapshotRefreshMs !== 0 && this.snapshotRefreshMs < 1000)) throw new BridgeError('invalid-refresh-rate', 'Native snapshot refresh cannot exceed one request per second.');
    this.snapshotRefreshCount = 0;
    this.nativeErrorThread = options.nativeErrorThread ?? process.env.BRIDGE_CODEX_ERROR_THREAD;
    this.nativeErrorFile = options.nativeErrorFile ?? process.env.BRIDGE_CODEX_ERROR_FILE;
    /** @type {Value[]} */ this.nativeErrors = [];
    /** @type {Map<string,Session>} */ this.sessions = new Map();
    this.disposed = false;
  }

  async status() {
    try {
      await this.ipc.connect();
      for (const session of this.sessions.values()) if (!session.releaseNative && !session.starting) this.recover(session);
      return { connected: true, mode: 'native' };
    } catch (error) { return { connected: false, mode: 'native', reason: error instanceof BridgeError ? error.code : 'codex-unavailable' }; }
  }

  /** @param {string} id */
  acquire(id) {
    if (this.disposed) throw new BridgeError('adapter-disposed', 'Codex backend is disposed.', 503);
    if (typeof id !== 'string' || !id.trim()) throw new BridgeError('invalid-session', 'A session identity is required.');
    let session = this.sessions.get(id);
    if (!session) {
      session = { id, refs: 0, generation: 0, ownerGeneration: null, state: null, view: null, projection: null, revision: null,
        callbacks: new Set(), waiters: new Set(), releaseNative: null, starting: null, recovering: null, retry: null,
        refreshTimer: null, refreshInFlight: false, incompleteRefreshes: 0, refreshTurn: null };
      this.sessions.set(id, session);
    }
    session.refs += 1;
    return session;
  }

  /** @param {Session} session */
  release(session) {
    session.refs -= 1;
    if (session.refs > 0) return;
    this.closeSession(session);
  }

  /** @param {Session} session */
  closeSession(session) {
    session.refs = 0;
    session.generation += 1;
    this.cancelRefresh(session, true);
    if (session.retry) clearTimeout(session.retry);
    session.retry = null;
    session.releaseNative?.();
    session.releaseNative = null;
    session.state = null; session.view = null; session.projection = null; session.revision = null;
    for (const waiter of session.waiters) { clearTimeout(waiter.timer); waiter.reject(new BridgeError('codex-unavailable', 'Codex subscription was released.', 503)); }
    session.waiters.clear(); session.callbacks.clear();
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
  }

  /** @param {Session} session @returns {Promise<void>} */
  ensure(session) {
    if (session.releaseNative && session.ownerGeneration !== null && session.ownerGeneration !== this.ipc.generation?.(session.id)) {
      // discovery 可先于新 stream 到达；旧缓存不能被当作新 owner 的快照，必须重新订阅并等真实帧。
      this.invalidate(session, 'resyncing'); session.releaseNative(); session.releaseNative = null;
    }
    if (session.releaseNative) return Promise.resolve();
    if (session.starting) return session.starting;
    const generation = ++session.generation;
    const operation = prepareNativeSchemas().then(() => this.ipc.subscribe(session.id, (frame) => {
      if (session.refs > 0 && session.generation === generation) this.receive(session, frame);
    })).then((release) => {
      if (session.refs <= 0 || session.generation !== generation) release();
      else session.releaseNative = release;
    }).finally(() => { if (session.starting === operation) session.starting = null; });
    session.starting = operation;
    return operation;
  }

  /** @param {Session} session @returns {Promise<View>} */
  waitForView(session) {
    if (session.state && session.view) return Promise.resolve(structuredClone(session.view));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        session.waiters.delete(waiter);
        reject(new BridgeError('codex-snapshot-timeout', 'No fresh Codex owner snapshot arrived.', 504));
      }, this.waitTimeoutMs) };
      session.waiters.add(waiter);
    });
  }

  /** @param {string} id @returns {Promise<View>} */
  async snapshot(id) {
    const session = this.acquire(id);
    try { await this.ensure(session); return await this.waitForView(session); }
    finally { this.release(session); }
  }

  /** @param {string} id @param {(view:View)=>void} onView @returns {Promise<()=>void>} */
  async subscribe(id, onView) {
    const session = this.acquire(id);
    try {
      await this.ensure(session);
      await this.waitForView(session);
      // 同一个 native 订阅的消费者各拿自己的值，避免 UI 写入污染另一个手机的状态。
      session.callbacks.add(onView);
      onView(structuredClone(session.view ?? emptyView('resyncing')));
    } catch (error) { session.callbacks.delete(onView); this.release(session); throw error; }
    let active = true;
    return () => {
      if (!active) return;
      active = false; session.callbacks.delete(onView); this.release(session);
    };
  }

  /** @param {Session} session @param {Value} frame */
  receive(session, frame) {
    if (frame.type === 'bridge/status') {
      if (['disconnected', 'owner-disconnected', 'owner-unavailable', 'subscription-error'].includes(frame.status)) {
        this.invalidate(session, frame.status === 'disconnected' ? 'disconnected' : 'resyncing');
        this.recover(session);
      }
      return;
    }
    if (frame.type !== 'broadcast' || frame.method !== 'thread-stream-state-changed') return;
    const change = frame.params?.change;
    if (!isRecord(change) || !Number.isSafeInteger(change.revision) || change.revision < 0) {
      this.invalidate(session, 'resyncing'); this.recover(session); return;
    }
    try {
      const frameOwner = typeof frame.sourceClientId === 'string' && typeof frame.params?.hostId === 'string' ? `${frame.params.hostId}:${frame.sourceClientId}` : null;
      if (change.type === 'patches' && frameOwner !== null && session.ownerGeneration !== null && frameOwner !== session.ownerGeneration) throw Error('Native patch owner did not match its base snapshot.');
      if (change.type === 'snapshot') {
        if (!isRecord(change.conversationState)) throw Error('Invalid native snapshot.');
        const sameOwner = session.ownerGeneration === frameOwner;
        // 静默工具输出由同 owner 的完整快照到达；全量校验后只替换实际改变的私有分支。
        session.state = cloneJson(change.conversationState, sameOwner ? session.state : undefined);
        session.ownerGeneration = frameOwner;
        if (!sameOwner) session.projection = null;
      } else if (change.type === 'patches') {
        if (session.revision !== null && change.revision <= session.revision) return;
        if (!session.state || change.baseRevision !== session.revision) throw Error('Native patch base did not match.');
        session.state = applyPatches(session.state, change.patches);
      } else throw Error('Unknown native stream change.');
      if (!session.state) throw Error('Missing native state.');
      session.revision = change.revision;
      session.projection = projectHistory(session.state, session.projection);
      session.view = projectView(session.state, change.revision, session.projection);
      if (session.ownerGeneration !== null) session.view.ownerGeneration = session.ownerGeneration;
      // 完整行摘要按顺序组合；只序列化改变的行，状态帧不再重复复制全部历史文本。
      const metadata = { ...session.view, rows: undefined };
      session.view.contentStamp = createHash('sha256').update('codelight-view-v1\0').update(session.projection.rowsDigest).update(JSON.stringify(metadata)).digest('hex');
      this.scheduleRefresh(session);
      this.publish(session);
      for (const waiter of session.waiters) { clearTimeout(waiter.timer); waiter.resolve(structuredClone(session.view)); }
      session.waiters.clear();
    } catch {
      // patch 基线不匹配时只能重新订阅读快照；重发输入会造成第二次执行。
      this.invalidate(session, 'resyncing'); this.recover(session);
    }
  }

  /** @param {Session} session @param {string} status */
  invalidate(session, status) {
    this.cancelRefresh(session, true);
    session.ownerGeneration = null;
    session.state = null; session.projection = null; session.revision = null; session.view = emptyView(status);
    this.publish(session);
  }

  /** @param {Session} session @param {boolean} [resetIncomplete] */
  cancelRefresh(session, resetIncomplete = false) {
    if (session.refreshTimer) clearTimeout(session.refreshTimer);
    session.refreshTimer = null;
    if (resetIncomplete) { session.incompleteRefreshes = 0; session.refreshTurn = null; }
  }

  /** @param {Session} session */
  scheduleRefresh(session) {
    const state = session.state;
    if (!this.snapshotRefreshMs || session.refs <= 0 || this.disposed || !state || session.view?.status !== 'active') { this.cancelRefresh(session, true); return; }
    const active = session.projection?.active;
    const silentTurn = session.projection?.silentTurn;
    const turnKey = string(active?.turnId) ?? string(active?.id) ?? string(silentTurn?.turnId) ?? string(silentTurn?.id);
    if (session.refreshTurn !== turnKey) { session.refreshTurn = turnKey; session.incompleteRefreshes = 0; }
    const items = active?.items;
    const incomplete = !silentTurn && (!active || !Array.isArray(items) || items.length === 0);
    const silentItem = !!silentTurn;
    if ((!silentItem && !incomplete) || (incomplete && session.incompleteRefreshes >= 5)) { this.cancelRefresh(session); return; }
    if (session.refreshTimer || session.refreshInFlight) return;
    const generation = session.generation;
    session.refreshTimer = setTimeout(() => {
      session.refreshTimer = null;
      if (session.refs <= 0 || session.generation !== generation || this.disposed || session.view?.status !== 'active') return;
      session.refreshInFlight = true;
      if (incomplete) session.incompleteRefreshes += 1;
      this.snapshotRefreshCount += 1;
      // 原 owner 明确不 push stdout/file delta；只再次声明已有 following 请求当前快照，绝不重发业务命令。
      this.ipc.refreshSnapshot(session.id).catch(() => {}).finally(() => {
        session.refreshInFlight = false;
        this.scheduleRefresh(session);
      });
    }, this.snapshotRefreshMs);
    session.refreshTimer.unref();
  }

  /** @param {Session} session */
  publish(session) {
    if (!session.view) return;
    for (const callback of session.callbacks) {
      try { callback(structuredClone(session.view)); } catch { /* 单个已关闭的 SSE 消费者不能破坏共享的 native 订阅。 */ }
    }
  }

  /** @param {Session} session */
  recover(session) {
    if (session.recovering || session.refs <= 0 || this.disposed) return;
    if (session.retry) { clearTimeout(session.retry); session.retry = null; }
    const operation = (async () => {
      await session.starting?.catch(() => {});
      if (session.refs <= 0 || this.disposed) return;
      session.generation += 1;
      session.releaseNative?.(); session.releaseNative = null;
      await this.ensure(session);
    })().catch(() => {
      if (session.refs > 0 && !this.disposed) {
        this.invalidate(session, 'disconnected');
        session.retry = setTimeout(() => { session.retry = null; this.recover(session); }, 1000);
        session.retry.unref();
      }
    }).finally(() => { if (session.recovering === operation) session.recovering = null; });
    session.recovering = operation;
  }

  /** Identity of the already discovered original owner. @param {string} id */
  generation(id) { return this.ipc.generation(id); }

  /** @param {string} id @param {string|null} [expectedGeneration] */
  async readControls(id, expectedGeneration) {
    const current = await this.ipc.readModelSettings(id, expectedGeneration);
    if (this.ipc.hostId !== 'local') return { model: { available: false, current, models: [], catalogSource: 'unavailable', reason: 'original-host-catalog-unavailable' } };
    try {
      const catalog = await this.loadModelCatalog(current.modelProvider, current.model);
      const models = Array.isArray(catalog.models) ? catalog.models : [];
      const latest = await this.ipc.readModelSettings(id, expectedGeneration);
      if (latest.modelProvider !== current.modelProvider) return { model: { available: false, current: latest, models: [], catalogSource: 'unavailable', reason: 'original-provider-changed' } };
      return { model: { available: models.some((/** @type {Value} */ m) => m.id === latest.model), current: latest, models, catalogSource: catalog.catalogSource ?? 'unavailable' } };
    } catch { return { model: { available: false, current, models: [], catalogSource: 'unavailable', reason: 'native-model-catalog-unavailable' } }; }
  }

  /** @param {string} id @param {string} action @param {unknown} payload @param {string} commandId @param {{expectedGeneration:string|null}} [context] @returns {Promise<Value>} */
  async command(id, action, payload, commandId, context) {
    if (!isRecord(payload)) throw new BridgeError('invalid-payload', 'Command payload must be an object.');
    try {
      let response;
      if (action === 'read-controls') {
        exactKeys(payload, []); return await this.readControls(id, context?.expectedGeneration);
      } else if (action === 'update-settings') {
        exactKeys(payload, ['model', 'reasoningEffort', 'expectedModel', 'expectedReasoningEffort']);
        const controls = await this.readControls(id, context?.expectedGeneration), current = controls.model.current;
        if (current.model !== payload.expectedModel || current.reasoningEffort !== payload.expectedReasoningEffort) throw new BridgeError('settings-conflict', 'The original settings changed before this choice.', 409);
        const model = controls.model.models.find((/** @type {Value} */ m) => m.id === payload.model);
        if (!controls.model.available || !model || payload.reasoningEffort != null && !model.reasoningEfforts.includes(payload.reasoningEffort)) throw new BridgeError('unsupported-model-settings', 'These settings are not in the original provider catalog.', 409);
        response = await this.ipc.updateModelSettings(id, /** @type {any} */ (payload), commandId, context?.expectedGeneration);
        if (response.result?.applied !== true) throw new BridgeError('settings-conflict', 'The original owner did not apply this stale choice.', 409);
        let updated;
        try { updated = await this.ipc.readModelSettings(id, context?.expectedGeneration); } catch { /* The exact applied acknowledgment survives a lost readback. */ }
        const settingsReadbackConfirmed = updated?.model === payload.model && updated?.reasoningEffort === payload.reasoningEffort;
        return { acknowledged: settingsReadbackConfirmed, applied: true, settingsReadbackConfirmed,
          controls: { ...controls, model: { ...controls.model, ...(updated ? { current: updated } : {}) } } };
      } else if (action === 'open-desktop') {
        exactKeys(payload, []);
        if (this.ipc.hostId !== 'local' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new BridgeError('unsupported-desktop-open', 'Only an existing local Codex chat UUID can be opened on this desktop.');
        // 原 Desktop 正常导航才能获得历史聊天 owner；不创建新 runtime，也不宣称已经连接。
        await this.openDesktop(`codex://threads/${id}`);
        return { action, requested: true, ownerReady: false };
      } else if (action === 'send' || action === 'steer') {
        exactKeys(payload, ['text']);
        if (typeof payload.text !== 'string' || !payload.text.trim()) throw new BridgeError('invalid-input', 'Message text is required.');
        response = action === 'send' ? await this.ipc.send(id, payload.text, commandId, context?.expectedGeneration) : await this.ipc.steer(id, payload.text, commandId, context?.expectedGeneration);
      } else if (action === 'answer-question') {
        exactKeys(payload, ['questionItemId', 'answer']);
        if (typeof payload.questionItemId !== 'string' || typeof payload.answer !== 'string' || !payload.answer.trim()) throw new BridgeError('invalid-answer', 'A native question identity and nonempty answer are required.');
        const view = await this.snapshot(id);
        const question = pendingNativeAsyncQuestions(view).find((question) => question.questionItemId === payload.questionItemId);
        if (!question) throw new BridgeError('stale-question', 'This native asynchronous question is unknown or already answered.', 409);
        const text = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: question.questionItemId, question: question.title, answer: payload.answer }])}\n</send_user_message_question_reply>`;
        response = await this.ipc.send(id, text, commandId, context?.expectedGeneration);
      } else if (action === 'interrupt') {
        exactKeys(payload, ['turnId']);
        if (typeof payload.turnId !== 'string' || !payload.turnId.trim()) throw new BridgeError('invalid-turn', 'An explicit current turn identity is required.');
        response = await this.ipc.interrupt({ sessionId: id, hostId: this.ipc.hostId, turnId: payload.turnId }, commandId, context?.expectedGeneration);
      } else if (action === 'approval') {
        const simple = ['command', 'file'].includes(payload.kind);
        exactKeys(payload, simple ? ['kind', 'decision', 'requestId'] : ['kind', 'response', 'requestId']);
        if (!['command', 'file', 'user-input', 'permissions', 'elicitation'].includes(payload.kind) ||
          (simple && !['accept', 'decline', 'cancel'].includes(payload.decision)) || !validRequestId(payload.requestId)) {
          throw new BridgeError('unsupported-approval', 'A supported native request identity and response are required.');
        }
        const view = await this.snapshot(id);
        const request = view.requests.find((request) => request.requestId === payload.requestId && request.kind === payload.kind && request.operable === true);
        if (!request) throw new BridgeError('stale-approval', 'The matching native approval is no longer pending.', 409);
        const target = { sessionId: id, hostId: this.ipc.hostId, requestId: payload.requestId };
        if (simple) {
          if (payload.decision === 'accept' && request.acceptSupported === false) throw new BridgeError('approval-details-unavailable', 'The native approval details are unavailable or unsupported; acceptance cannot be displayed safely.', 409);
          response = await this.ipc.respondApproval({ ...target, kind: payload.kind }, payload.decision, commandId, context?.expectedGeneration);
        }
        else {
          const nativeResponse = await validateNativeResponse(payload.kind, payload.response);
          if (payload.kind === 'user-input') {
            validateQuestionResponse(request, nativeResponse);
            response = await this.ipc.respondUserInput(target, nativeResponse, commandId, context?.expectedGeneration);
          } else if (payload.kind === 'permissions') {
            validatePermissionSubset(request.requestedPermissions ?? {}, nativeResponse);
            response = await this.ipc.respondPermissions(target, nativeResponse, commandId, context?.expectedGeneration);
          } else {
            validateFormResponse(request, nativeResponse);
            response = await this.ipc.respondElicitation(target, nativeResponse, commandId, context?.expectedGeneration);
          }
        }
      } else throw new BridgeError('unsupported-action', 'This operation has no supported native Codex contract.');
      return actionResult(action, response);
    } catch (error) {
      if (id === this.nativeErrorThread && this.nativeErrorFile && error instanceof BridgeError) {
        // 专用验收只保存原生错误，绝不把用户输入、恢复上下文或认证数据写入诊断。
        this.nativeErrors.push({ threadId: id, action, commandId, code: error.code, message: redactNativeError(error.message), at: new Date().toISOString() });
        this.nativeErrors = this.nativeErrors.slice(-32);
        await writePrivateJson(this.nativeErrorFile, this.nativeErrors).catch(() => {});
      }
      if (error instanceof BridgeError && ['codex-outcome-unknown', 'codex-disconnected', 'codex-protocol-error'].includes(error.code)) {
        throw new BridgeError('delivery-unknown', 'The native action may have been accepted; its result is unconfirmed and it must not be resent automatically.', 409);
      }
      throw error;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const session of this.sessions.values()) this.closeSession(session);
    this.ipc.dispose();
  }
}

/** @param {string} status @returns {View} */
function emptyView(status) { return { rows: [], currentTurnId: null, status, requests: [], revision: null }; }

/** @param {unknown} value @returns {value is Value} */
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** Validate all incoming JSON while reusing only exact private branches.
 * @param {unknown} value @param {any} [previous] @returns {any} */
function cloneJson(value, previous) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    const prior = Array.isArray(previous) ? previous : null;
    let output = prior && prior.length === value.length ? null : new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) { if (!output && prior && index in prior) { output = prior.slice(); delete output[index]; } continue; }
      const child = cloneJson(value[index], prior?.[index]);
      if (!output && (!prior || !(index in prior) || !Object.is(child, prior[index]))) output = prior?.slice() ?? new Array(value.length);
      if (output) output[index] = child;
    }
    return output ?? prior;
  }
  if (!isRecord(value)) throw Error('Non-JSON native value.');
  const keys = Object.keys(value);
  const prior = isRecord(previous) ? previous : null;
  let output = prior && sameReferences(keys, Object.keys(prior)) ? null : /** @type {Value} */ ({});
  for (const key of keys) {
    if (FORBIDDEN.has(key)) throw Error('Unsafe native object key.');
    const child = cloneJson(value[key], prior && Object.hasOwn(prior, key) ? prior[key] : undefined);
    if (!output && !Object.is(child, prior?.[key])) output = { ...prior };
    if (output) Object.defineProperty(output, key, { enumerable: true, writable: true, configurable: true, value: child });
  }
  return output ?? prior;
}

/** Apply a complete Immer patch batch atomically using private path copies.
 * @param {Value} base @param {unknown} patches @returns {Value} */
function applyPatches(base, patches) {
  if (!Array.isArray(patches) || patches.length > 50_000) throw Error('Invalid native patch list.');
  let output = base;
  const owned = new WeakSet();
  /** @param {Value} value @returns {Value} */
  const writable = (value) => {
    if (owned.has(value)) return value;
    const copy = Array.isArray(value) ? value.slice() : { ...value };
    owned.add(copy); return copy;
  };
  for (const patch of patches) {
    if (!isRecord(patch) || !['add', 'remove', 'replace'].includes(patch.op) || !Array.isArray(patch.path) || patch.path.length > 256) throw Error('Invalid Immer patch.');
    for (const key of patch.path) if ((typeof key !== 'string' && !(Number.isSafeInteger(key) && key >= 0)) || FORBIDDEN.has(key)) throw Error('Unsafe Immer path.');
    if (patch.path.length === 0) {
      if (patch.op === 'remove' || !isRecord(patch.value)) throw Error('Invalid root patch.');
      output = cloneJson(patch.value); continue;
    }
    // 批次只修改本地副本；后续路径校验失败也不能污染上一 revision 的共享分支。
    output = writable(output);
    let parent = output;
    for (const key of patch.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw Error('Missing native patch path.');
      const child = parent[key];
      if (!Array.isArray(child) && !isRecord(child)) throw Error('Missing native patch path.');
      parent[key] = writable(child);
      parent = parent[key];
    }
    const key = patch.path.at(-1);
    if (Array.isArray(parent)) {
      if (key === 'length' && patch.op === 'replace' && Number.isSafeInteger(patch.value) && patch.value >= 0 && patch.value <= parent.length) { parent.length = patch.value; continue; }
      if (!Number.isSafeInteger(key) || key < 0 || key > parent.length || (patch.op !== 'add' && key >= parent.length)) throw Error('Invalid native array index.');
      if (patch.op === 'add') parent.splice(key, 0, cloneJson(patch.value));
      else if (patch.op === 'remove') parent.splice(key, 1);
      else parent[key] = cloneJson(patch.value);
    } else {
      if (!isRecord(parent) || typeof key !== 'string' || (patch.op !== 'add' && !Object.hasOwn(parent, key))) throw Error('Invalid native object path.');
      if (patch.op === 'remove') delete parent[key];
      else Object.defineProperty(parent, key, { enumerable: true, writable: true, configurable: true, value: cloneJson(patch.value) });
    }
  }
  if (!isRecord(output)) throw Error('Invalid native state.');
  return output;
}

/** @param {unknown} value @returns {string|null} */
function string(value) { return typeof value === 'string' ? value : null; }
/** @param {unknown} value @returns {string} */
function textContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => typeof part === 'string' ? part : isRecord(part) &&
    ['text', 'input_text', 'output_text', 'inputText', 'outputText', 'summary_text'].includes(part.type) ? string(part.text) ?? '' : '').filter(Boolean).join('\n');
}

/** @param {Value} state @returns {Value[]} */
function loadedTurns(state) {
  /** @type {Value[]} */ let turns = [];
  const history = state.turnHistory?.history;
  if (isRecord(history?.entitiesByKey) && Array.isArray(history.islands)) {
    for (const island of history.islands) if (Array.isArray(island.entries)) for (const entry of island.entries) {
      const turn = history.entitiesByKey[entry.value];
      if (isRecord(turn)) turns.push(turn);
    }
  }
  if (!turns.length && Array.isArray(state.turns)) turns = state.turns.filter(isRecord);
  return turns;
}

/** @param {Value} state @param {Projection|null} previous @returns {Projection} */
function projectHistory(state, previous) {
  const work = { projectedTurns: 0, projectedItems: 0, serializedRowBytes: 0 };
  const historyUnchanged = previous && state.turnHistory === previous.state.turnHistory && state.turns === previous.state.turns;
  if (historyUnchanged) return { ...previous, state, work,
    requests: state.requests === previous.state.requests ? previous.requests : projectRequests(state, previous.turns) };
  const turns = loadedTurns(state);
  const priorBySource = new Map(previous?.entries.map((entry) => [entry.source, entry]));
  const entriesBefore = turns.map((turn, index) => priorBySource.get(turn) ?? previous?.entries[index]);
  const dependenciesByTurn = turns.map((turn, index) => entriesBefore[index]?.source === turn ? entriesBefore[index].dependencies : asyncDependencies(turn));
  const dependencies = dependenciesByTurn.flat();
  const dependenciesUnchanged = previous && sameReferences(previous.dependencies, dependencies);
  // 问题标题及已接受回复可以影响早先 turn；这类变更明确整体重算，不能缓存成局部状态。
  const questions = dependenciesUnchanged ? previous.questions : nativeAsyncQuestions(turns);
  const answers = dependenciesUnchanged ? previous.answers : nativeAsyncAnswers(turns, questions);
  const entries = turns.map((turn, index) => {
    const prior = dependenciesUnchanged ? entriesBefore[index] : null;
    if (prior?.source === turn && prior.index === index) return prior;
    return projectTurn(turn, index, questions, answers, prior, dependenciesByTurn[index], work);
  });
  const seen = new Set();
  /** @type {Row[]} */ const rows = [];
  let currentTurnId = null;
  /** @type {Value|null} */ let active = null;
  /** @type {Value|null} */ let silentTurn = null;
  for (const entry of entries) {
    if (['inProgress', 'running', 'active'].includes(entry.source.status)) { active = entry.source; currentTurnId = string(active.turnId) ?? string(active.id); }
    if (entry.silent) silentTurn = entry.source;
    for (const candidate of entry.candidates) {
      if (seen.has(candidate.sourceId) || seen.has(candidate.row.id)) continue;
      seen.add(candidate.row.id); rows.push(candidate.row);
    }
  }
  const rowDigests = previous?.rowDigests ?? new WeakMap();
  const rowsDigest = fingerprintRows(rows, rowDigests, work);
  return { state, turns, entries, dependencies, questions, answers, rows, rowsDigest, rowDigests, currentTurnId, active, silentTurn, requests: projectRequests(state, turns), work };
}

/** @param {unknown[]} left @param {unknown[]} right */
function sameReferences(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }

/** @param {Value} turn @returns {unknown[]} */
function asyncDependencies(turn) {
  const input = textContent(Array.isArray(turn.params?.input) ? turn.params.input.filter(isRecord) : []);
  const dependencies = input.trim().startsWith('<send_user_message_question_reply>') ? [turn.params.input] : [];
  for (const item of Array.isArray(turn.items) ? turn.items : []) {
    if (!isRecord(item)) continue;
    if (item.type === 'agentMessage' && Array.isArray(item.questions)) { dependencies.push(item); continue; }
    if (item.type === 'userMessage' || item.type === 'message' && item.role === 'user' || item.type === 'steeringUserMessage') {
      const text = item.type === 'steeringUserMessage' ? textContent(item.input) : string(item.text) ?? textContent(item.content);
      if (text.trim().startsWith('<send_user_message_question_reply>')) dependencies.push(item);
    }
  }
  return dependencies;
}

/** @param {Value} state @param {Value[]} turns @returns {Value[]} */
function projectRequests(state, turns) { return (Array.isArray(state.requests) ? state.requests : []).filter(isRecord).map((request) => projectRequest(request, turns)); }

/** @param {Row[]} rows @param {WeakMap<Row,string>} digests @param {ProjectionWork} work */
function fingerprintRows(rows, digests, work) {
  const hash = createHash('sha256').update('codelight-rows-v1\0');
  for (const row of rows) {
    let digest = digests.get(row);
    if (!digest) {
      const json = JSON.stringify(row);
      work.serializedRowBytes += Buffer.byteLength(json);
      digest = createHash('sha256').update('codelight-row-v1\0').update(json).digest('hex');
      digests.set(row, digest);
    }
    hash.update(digest);
  }
  return hash.digest('hex');
}

/** @param {Value} turn @param {number} turnIndex @param {Map<string,Value>} questions @param {Map<string,string>} answers @param {TurnProjection|null|undefined} previous @param {unknown[]} dependencies @param {ProjectionWork} work @returns {TurnProjection} */
function projectTurn(turn, turnIndex, questions, answers, previous, dependencies, work) {
    work.projectedTurns += 1;
    const turnId = string(turn.turnId) ?? string(turn.id);
    const status = string(turn.status);
    const at = typeof turn.turnStartedAtMs === 'number' ? turn.turnStartedAtMs : null;
    const context = JSON.stringify([turnId, status, at, turnId === null ? turnIndex : null]);
    const items = Array.isArray(turn.items) ? turn.items : [];
    /** @type {Candidate[]} */ const candidates = [];
    /** @type {Map<Value,{index:number,candidate:Candidate|null}>} */ const itemCache = new Map();
    /** @type {Map<string,Value>} */ const usersByClient = new Map();
    let silent = false;
    for (const item of items) {
      if (item?.type === 'userMessage' && typeof item.clientId === 'string' && !usersByClient.has(item.clientId)) usersByClient.set(item.clientId, item);
      if (['commandExecution', 'fileChange'].includes(item?.type) && ['inProgress', 'running', 'pending'].includes(item.status)) silent = true;
    }
    const input = textContent(Array.isArray(turn.params?.input) ? turn.params.input.filter(isRecord) : []);
    const clientMessageId = string(turn.params?.clientUserMessageId);
    const openingUserItem = items.some((/** @type {Value} */ item) => item?.type === 'userMessage' &&
      (clientMessageId && item.clientId ? item.clientId === clientMessageId : textContent(item.content) === input));
    // 原 owner 在 userMessage 通知之前已公布 params.input；只补这个可见输入，通知到达即替换临时行。
    if (input && !openingUserItem) {
      const id = `pending-user:${clientMessageId ?? turnId ?? turnIndex}`;
      candidates.push({ sourceId: id, row: { id, role: 'user', text: displayAsyncReply(input, questions), tools: [], turnId, status, at,
        ...(clientMessageId ? { commandId: clientMessageId } : {}) } });
    }
    for (const [itemIndex, item] of items.entries()) {
      if (!isRecord(item)) continue;
      const cached = previous?.context === context ? previous.items.get(item) : null;
      if (cached && (typeof item.id === 'string' || cached.index === itemIndex) && item.type !== 'steeringUserMessage') {
        itemCache.set(item, cached);
        if (cached.candidate) candidates.push(cached.candidate);
        continue;
      }
      work.projectedItems += 1;
      itemCache.set(item, { index: itemIndex, candidate: null });
      let id = string(item.id) ?? `${turnId ?? turnIndex}:${itemIndex}`;
      const sourceId = id;
      let role = '';
      let text = '';
      /** @type {Value[]} */ let tools = [];
      /** @type {Value[]} */ let asyncQuestions = [];
      if (['userMessage', 'agentMessage', 'assistantMessage', 'message'].includes(item.type)) {
        role = item.role ?? (item.type === 'userMessage' ? 'user' : 'assistant');
        if (!['user', 'assistant'].includes(role)) continue;
        text = string(item.text) ?? textContent(item.content);
        if (item.type === 'agentMessage') asyncQuestions = (Array.isArray(item.questions) ? item.questions : []).flatMap((/** @type {Value} */ question, /** @type {number} */ questionIndex) => {
          const questionItemId = JSON.stringify(['request_user_input_async', id, questionIndex]);
          const publicQuestion = questions.get(questionItemId);
          return publicQuestion ? [{ ...publicQuestion, answered: answers.has(questionItemId), ...(answers.has(questionItemId) ? { answer: answers.get(questionItemId) } : {}) }] : [];
        });
        if (role === 'user') text = displayAsyncReply(text, questions);
      } else if (item.type === 'steeringUserMessage') {
        const serverItem = typeof item.clientUserMessageId === 'string' ? usersByClient.get(item.clientUserMessageId) : null;
        id = string(item.serverUserMessageId) ?? string(serverItem?.id) ?? id;
        role = 'user';
        text = textContent(Array.isArray(item.input) ? item.input.filter(isRecord) : []);
        text = displayAsyncReply(text, questions);
      } else if (item.type === 'reasoning') {
        // 手机仅复用原应用公开的 summary，不从内部 content/text 扩大推理可见范围。
        role = 'reasoning'; text = textContent(item.summary);
      } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'function_call', 'function_call_output'].includes(item.type)) {
        role = 'tool';
        const name = string(item.tool) ?? string(item.name) ?? string(item.command) ?? string(item.type) ?? 'Tool';
        const output = item.type === 'fileChange' ? displayFileChanges(item.changes).map((change) => `${change.kind} ${change.path}${change.movePath ? ` → ${change.movePath}` : ''}\n${change.diff}`).join('\n\n') :
          string(item.aggregatedOutput) ?? string(item.output) ?? (textContent(item.result?.content) || textContent(item.result?.contentItems));
        tools = [{ id, name, output, status: string(item.status) }];
      } else if (item.type === 'error') { role = 'assistant'; text = string(item.message) ?? ''; }
      if (!role || (!text && !tools.length && !asyncQuestions.length)) continue;
      // 原生 caller id 是通信记录关联依据；同文案可能来自不同作者，不能按文字去重。
      const commandId = role === 'user' ? string(item.clientId) ?? string(item.clientUserMessageId) : null;
      const row = { id, role, text, tools, turnId, status, at,
        ...(commandId ? { commandId } : {}),
        ...(asyncQuestions.length ? { asyncQuestions } : {}) };
      const candidate = { sourceId, row };
      itemCache.set(item, { index: itemIndex, candidate });
      candidates.push(candidate);
    }
    return { source: turn, index: turnIndex, context, candidates, items: itemCache, dependencies, silent };
}

/** @param {Value} state @param {number} revision @param {Projection} projection @returns {View} */
function projectView(state, revision, projection) {
  const { turns, rows, currentTurnId, requests } = projection;
  // runtime active 也可能是后台终端；completed turn 不能被制造成前台 generation 的停止身份。
  const status = string(state.threadRuntimeStatus?.type) ?? (currentTurnId ? 'active' : 'idle');
  const model = string(state.latestCollaborationMode?.settings?.model) ?? string(state.latestModel);
  const latest = turns.at(-1);
  const latestTurnId = string(latest?.turnId) ?? string(latest?.id);
  return { rows, currentTurnId, latestTurnId, status, requests, revision, ...(model ? { nativeControlsCurrent: { model, reasoningEffort: string(state.latestReasoningEffort), modelProvider: string(state.modelProvider) } } : {}) };
}

/** The exact packaged renderer x1t/p1t identity and public field mapping.
 * @param {Value[]} turns @returns {Map<string,Value>} */
function nativeAsyncQuestions(turns) {
  const result = new Map();
  for (const turn of turns) for (const item of Array.isArray(turn.items) ? turn.items : []) {
    if (item?.type !== 'agentMessage' || typeof item.id !== 'string' || !Array.isArray(item.questions)) continue;
    item.questions.forEach((/** @type {Value} */ question, /** @type {number} */ questionIndex) => {
      if (typeof question?.title !== 'string') return;
      const questionItemId = JSON.stringify(['request_user_input_async', item.id, questionIndex]);
      result.set(questionItemId, { questionItemId, sourceItemId: item.id, questionIndex, title: question.title,
        options: Array.isArray(question.options) ? question.options.filter((/** @type {unknown} */ option) => typeof option === 'string') : [] });
    });
  }
  return result;
}

/** @param {string} text @returns {Value[]|null} */
function parseAsyncReply(text) {
  const open = '<send_user_message_question_reply>'; const close = '</send_user_message_question_reply>';
  const value = text.trim();
  if (!value.startsWith(open) || !value.endsWith(close)) return null;
  try {
    const parsed = JSON.parse(value.slice(open.length, -close.length));
    const replies = Array.isArray(parsed) ? parsed : [parsed];
    return replies.length && replies.every((reply) => isRecord(reply) && typeof reply.questionItemId === 'string' && typeof reply.question === 'string' && typeof reply.answer === 'string') ? replies : null;
  } catch { return null; }
}

/** @param {Value[]} turns @param {Map<string,Value>} questions */
function nativeAsyncAnswers(turns, questions) {
  const answers = new Map();
  for (const turn of turns) for (const item of Array.isArray(turn.items) ? turn.items : []) {
    if (item?.type !== 'userMessage' && !(item?.type === 'steeringUserMessage' && item.status === 'accepted')) continue;
    const text = textContent(item.type === 'userMessage' ? item.content : item.input);
    for (const reply of parseAsyncReply(text) ?? []) if (questions.has(reply.questionItemId)) answers.set(reply.questionItemId, reply.answer);
  }
  return answers;
}

/** @param {string} text @param {Map<string,Value>} questions */
function displayAsyncReply(text, questions) {
  const replies = parseAsyncReply(text);
  return replies?.length && replies.every((reply) => questions.has(reply.questionItemId)) ? replies.map((reply) => `${questions.get(reply.questionItemId)?.title}\n${reply.answer}`).join('\n\n') : text;
}

/** @param {Value} request @param {Value[]} turns @returns {Value} */
function projectRequest(request, turns) {
  const method = string(request.method) ?? 'unknown';
  const params = isRecord(request.params) ? request.params : {};
  const kind = method === 'item/commandExecution/requestApproval' ? 'command' : method === 'item/fileChange/requestApproval' ? 'file' :
    method === 'item/tool/requestUserInput' ? 'user-input' : method === 'item/permissions/requestApproval' ? 'permissions' :
      method === 'mcpServer/elicitation/request' ? 'elicitation' : 'unsupported';
  const result = { requestId: validRequestId(request.id) ? request.id : null, kind,
    operable: kind !== 'unsupported' && validRequestId(request.id), turnId: string(params.turnId),
    reason: string(params.reason), command: kind === 'command' ? string(params.command) : null };
  const relatedItem = findApprovalItem(turns, params.turnId, params.itemId, kind === 'file' ? 'fileChange' : 'commandExecution');
  if (kind === 'file') {
    const changes = displayFileChanges(relatedItem?.changes);
    const detailsAvailable = !!relatedItem && Array.isArray(relatedItem.changes) && changes.length === relatedItem.changes.length && changes.length > 0;
    const grantRoot = string(params.grantRoot);
    return { ...result, itemId: string(params.itemId), changes, grantRoot,
      grantScope: grantRoot ? 'requested-session-root' : 'file-change', grantRootHonored: grantRoot ? 'unverified' : null,
      detailsAvailable, acceptSupported: detailsAvailable, allowedActions: detailsAvailable ? ['accept', 'decline', 'cancel'] : ['decline', 'cancel'] };
  }
  if (kind === 'command') {
    const nativeKind = params.kind === 'writeStdin' ? 'writeStdin' : 'command';
    const command = string(params.command) ?? (nativeKind === 'command' ? string(relatedItem?.command) : null);
    const network = displayNetworkContext(params.networkApprovalContext);
    const actions = displayCommandActions(params.commandActions);
    const contextSupported = params.networkApprovalContext == null || network !== null;
    const detailsAvailable = contextSupported && (!!command || !!network || actions.length > 0);
    return { ...result, command, nativeKind, itemId: string(params.itemId), approvalId: string(params.approvalId), cwd: string(params.cwd),
      commandActions: actions, networkApprovalContext: network, grantScope: nativeKind === 'writeStdin' ? 'terminal-input' : 'command',
      proposedNetworkPolicyAmendments: displayNetworkAmendments(params.proposedNetworkPolicyAmendments),
      proposedExecpolicyAmendment: Array.isArray(params.proposedExecpolicyAmendment) ? params.proposedExecpolicyAmendment.filter((/** @type {unknown} */ part) => typeof part === 'string') : null,
      detailsAvailable, acceptSupported: detailsAvailable, allowedActions: detailsAvailable ? ['accept', 'decline', 'cancel'] : ['decline', 'cancel'] };
  }
  if (kind === 'user-input') return { ...result, questions: (Array.isArray(params.questions) ? params.questions : []).filter(isRecord).map((question) => ({
    id: string(question.id), header: string(question.header), question: string(question.question), secret: question.isSecret === true, other: question.isOther === true,
    options: (Array.isArray(question.options) ? question.options : []).filter(isRecord).map((option) => ({ label: string(option.label), description: string(option.description) })) })) };
  if (kind === 'permissions') {
    const permissions = displayPermissions(params.permissions);
    const supported = isRecord(params.permissions) && supportsNativePermissions(permissions);
    return { ...result, requestedPermissions: supported ? permissions : null, operable: result.operable && supported,
      grantScopes: ['turn', 'session'], defaultGrantScope: 'turn', unsupportedReason: supported ? null : 'permission-schema-mismatch' };
  }
  if (kind === 'elicitation') {
    const mode = string(params.mode);
    const form = ['form', 'openai/form', 'openaiForm'].includes(mode ?? '');
    const schema = form ? displaySchema(params.requestedSchema) : null;
    const acceptSupported = mode === 'url' || (form && supportsForm(schema));
    return { ...result, mode, message: string(params.message), requestedSchema: schema,
      url: mode === 'url' ? string(params.url) : null,
      operable: result.operable && (form || ['url', 'openai/userVerification'].includes(mode ?? '')),
      acceptSupported, allowedActions: acceptSupported ? ['accept', 'decline', 'cancel'] : ['decline', 'cancel'],
      unsupportedReason: mode === 'openai/userVerification' ? 'native-verification-required' : form && !acceptSupported ? 'unsupported-form-schema' : null };
  }
  return result;
}

/** @param {unknown} permissions @returns {Value} */
function displayPermissions(permissions) {
  if (!isRecord(permissions)) return {};
  const output = /** @type {Value} */ ({});
  if (Object.hasOwn(permissions, 'network')) {
    output.network = isRecord(permissions.network) ? pick(permissions.network, ['enabled']) : cloneJson(permissions.network);
  }
  if (Object.hasOwn(permissions, 'fileSystem') && !isRecord(permissions.fileSystem)) output.fileSystem = cloneJson(permissions.fileSystem);
  if (isRecord(permissions.fileSystem)) {
    const fs = permissions.fileSystem;
    const value = /** @type {Value} */ ({});
    // 旧投影过滤掉显式 null，导致 special.subpath 等合法请求无法保真重建授权回应。
    for (const key of ['read', 'write', 'globScanMaxDepth']) if (Object.hasOwn(fs, key)) value[key] = cloneJson(fs[key]);
    if (Object.hasOwn(fs, 'entries')) value.entries = Array.isArray(fs.entries) ? fs.entries.map((entry) => {
      if (!isRecord(entry)) return cloneJson(entry);
      const result = pick(entry, ['access']);
      if (Object.hasOwn(entry, 'path')) result.path = displayPermissionPath(entry.path);
      return result;
    }) : cloneJson(fs.entries);
    output.fileSystem = value;
  }
  return output;
}

/** @param {unknown} path @returns {any} */
function displayPermissionPath(path) {
  if (!isRecord(path)) return cloneJson(path);
  if (path.type === 'path') return pick(path, ['type', 'path']);
  if (path.type === 'glob_pattern') return pick(path, ['type', 'pattern']);
  const output = pick(path, ['type']);
  if (Object.hasOwn(path, 'value')) {
    if (!isRecord(path.value)) output.value = cloneJson(path.value);
    else {
      const keys = path.value.kind === 'unknown' ? ['kind', 'path', 'subpath'] : path.value.kind === 'project_roots' ? ['kind', 'subpath'] : ['kind'];
      output.value = pick(path.value, keys);
    }
  }
  return output;
}

/** @param {Value} object @param {string[]} keys @returns {Value} */
function pick(object, keys) {
  const output = /** @type {Value} */ ({});
  for (const key of keys) if (Object.hasOwn(object, key)) output[key] = cloneJson(object[key]);
  return output;
}

/** @param {Value[]} turns @param {unknown} turnId @param {unknown} itemId @param {string} type @returns {Value|null} */
function findApprovalItem(turns, turnId, itemId, type) {
  if (typeof itemId !== 'string') return null;
  for (const turn of turns) {
    if (typeof turnId === 'string' && (turn.turnId ?? turn.id) !== turnId) continue;
    const item = (Array.isArray(turn.items) ? turn.items : []).find((/** @type {Value} */ item) => item?.id === itemId && item.type === type);
    if (isRecord(item)) return item;
  }
  return null;
}

/** @param {unknown} changes @returns {Value[]} */
function displayFileChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes.filter(isRecord).filter((change) => typeof change.path === 'string' && typeof change.diff === 'string' &&
    ['add', 'delete', 'update'].includes(change.kind?.type)).map((change) => ({ path: change.path, kind: change.kind.type,
    movePath: change.kind.type === 'update' ? string(change.kind.move_path) : null, diff: change.diff }));
}

/** @param {unknown} context @returns {Value|null} */
function displayNetworkContext(context) {
  return isRecord(context) && typeof context.host === 'string' && ['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(context.protocol)
    ? { host: context.host, protocol: context.protocol } : null;
}

/** @param {unknown} amendments @returns {Value[]} */
function displayNetworkAmendments(amendments) {
  return Array.isArray(amendments) ? amendments.filter(isRecord).filter((rule) => typeof rule.host === 'string' && ['allow', 'deny'].includes(rule.action))
    .map((rule) => ({ host: rule.host, action: rule.action })) : [];
}

/** @param {unknown} actions @returns {Value[]} */
function displayCommandActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.filter(isRecord).filter((action) => ['read', 'listFiles', 'search', 'unknown'].includes(action.type) && typeof action.command === 'string').map((action) => {
    const keys = action.type === 'read' ? ['type', 'command', 'name', 'path'] : action.type === 'search' ? ['type', 'command', 'path', 'query'] :
      action.type === 'listFiles' ? ['type', 'command', 'path'] : ['type', 'command'];
    return pick(action, keys);
  });
}

/** Copy schema vocabulary only; foreign metadata and arbitrary request params never enter the view.
 * @param {unknown} schema @returns {any} */
function displaySchema(schema) {
  if (typeof schema === 'boolean') return schema;
  if (!isRecord(schema)) return null;
  const output = /** @type {Value} */ ({});
  for (const key of ['$schema', '$id', '$ref', 'type', 'title', 'description', 'format', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems', 'const', 'enum', 'enumNames', 'required', 'default']) {
    if (Object.hasOwn(schema, key)) output[key] = cloneJson(schema[key]);
  }
  for (const key of ['properties', 'definitions', '$defs', 'patternProperties']) if (isRecord(schema[key])) {
    output[key] = {};
    for (const [name, child] of Object.entries(schema[key])) if (!FORBIDDEN.has(name)) output[key][name] = displaySchema(child);
  }
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']) {
    if (Object.hasOwn(schema, key)) output[key] = Array.isArray(schema[key]) ? schema[key].map(displaySchema) : displaySchema(schema[key]);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) if (Array.isArray(schema[key])) output[key] = schema[key].map(displaySchema);
  // 未识别的验证关键词不能删除后当成更宽松的可接受表单。
  const known = new Set([...Object.keys(output), '$comment', 'examples']);
  if (Object.keys(schema).some((key) => !known.has(key))) output.__unsupportedSchemaKeyword = true;
  return output;
}

/** @param {unknown} value */
function validRequestId(value) { return (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isSafeInteger(value)); }
/** @param {Value} payload @param {string[]} keys */
function exactKeys(payload, keys) {
  if (Object.keys(payload).length !== keys.length || Object.keys(payload).some((key) => !keys.includes(key))) throw new BridgeError('invalid-payload', 'Command payload fields did not match the native operation.');
}
/** @param {string} action @param {Value} response @returns {Value} */
function actionResult(action, response) {
  const result = { action, acknowledged: true };
  const native = isRecord(response.result?.result) ? response.result.result : isRecord(response.result) ? response.result : {};
  /** @type {Value} */ const metadata = {};
  for (const key of ['turnId', 'interruptedTurnId', 'messageId', 'queuedSubmissionId', 'revision', 'status', 'kind', 'ok']) {
    if (['string', 'number', 'boolean'].includes(typeof native[key])) metadata[key] = native[key];
  }
  if (typeof native.turn?.id === 'string') metadata.turnId = native.turn.id;
  return { ...result, ...metadata };
}

/** @param {string} message */
function redactNativeError(message) {
  return message.replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret|cookie)\s*["']?\s*[:=]\s*["']?)[^\s"'&,;}]*/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s/"']+/gi, '[host-redacted]')
    .slice(0, 4096);
}

/** @param {string} uri */
async function openLocalCodexDesktop(uri) {
  if (process.platform !== 'darwin') throw new BridgeError('unsupported-desktop-open', 'Opening the existing Codex desktop is currently supported on macOS.', 409);
  // 只导航已经运行的原应用，不能让 URL handler 启动另一份 Desktop/runtime。
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'comm='], { timeout: 5000, maxBuffer: 1024 * 1024 });
  const running = stdout.split('\n').map(value => value.trim()).find(value => /^\/.*\/(ChatGPT|Codex)\.app\/Contents\/MacOS\/(ChatGPT|Codex)$/.test(value));
  if (!running) throw new BridgeError('codex-unavailable', 'The original desktop application is not running.', 409);
  const app = running.slice(0, running.lastIndexOf('/Contents/MacOS/'));
  await promisify(execFile)('/usr/bin/open', ['-a', app, uri], { timeout: 5000, maxBuffer: 4096 });
}

const nativeCatalogCache = /** @type {Map<string,{expires:number,value:Promise<Value>}>} */ (new Map());
/** Narrow scalar TOML reader: unsupported provider syntax leaves controls unavailable rather than guessing credentials.
 * @param {string} text @returns {Map<string,Value>} */
function nativeConfigTables(text) {
  const tables = new Map(); let name = '';
  tables.set(name, {});
  for (const line of text.split('\n')) {
    const header = line.trim().match(/^\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (header) { name = header[1]; if (!tables.has(name)) tables.set(name, {}); continue; }
    const field = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|true|false)\s*(?:#.*)?$/u);
    if (!field) continue;
    try { tables.get(name)[field[1]] = field[2][0] === "'" ? field[2].slice(1, -1) : JSON.parse(field[2]); } catch { /* unsupported string escapes */ }
  }
  return tables;
}
/** Return only original provider-listed models with known native capabilities.
 * Existing cache is capability metadata only: it cannot authorize a foreign account's model ID.
 * @param {string|null} modelProvider @param {string} currentModel
 * @param {{home?:string,fetch?:typeof fetch}} [options] @returns {Promise<Value>} */
export async function loadNativeCodexModelCatalog(modelProvider, currentModel, options = {}) {
  const root = options.home ?? join(homedir(), '.codex');
  const tables = nativeConfigTables(await readFile(join(root, 'config.toml'), 'utf8'));
  const global = tables.get('') ?? {}, providerId = modelProvider ?? global.model_provider ?? 'openai';
  if (typeof providerId !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(providerId)) throw new BridgeError('native-model-catalog-unavailable', 'The original provider catalog cannot be identified.');
  const provider = tables.get(`model_providers.${providerId}`) ?? {};
  let cached = /** @type {Value} */ ({});
  try { cached = JSON.parse(await readFile(join(root, 'models_cache.json'), 'utf8')); } catch { /* a detailed provider response can stand on its own */ }
  const explicitFile = global.model_catalog_json;
  if (typeof explicitFile === 'string') {
    const path = isAbsolute(explicitFile) ? explicitFile : resolve(root, explicitFile);
    const data = JSON.parse(await readFile(path, 'utf8'));
    return { models: normaliseNativeCodexModels(data.models ?? data, currentModel), catalogSource: 'original-config-catalog' };
  }
  const endpoint = typeof provider.model_catalog_url === 'string' ? provider.model_catalog_url : typeof provider.base_url === 'string' ? provider.base_url.replace(/\/$/u, '') + '/models' : null;
  if (!endpoint) throw new BridgeError('native-model-catalog-unavailable', 'The original provider does not expose a configured catalog.');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BridgeError('native-model-catalog-unavailable', 'The original provider catalog origin is invalid.');
  if (typeof cached.client_version === 'string' && /^\d+\.\d+\.\d+$/u.test(cached.client_version)) url.searchParams.set('client_version', cached.client_version);
  const credential = typeof provider.experimental_bearer_token === 'string' ? provider.experimental_bearer_token : typeof provider.env_key === 'string' ? process.env[provider.env_key] : null;
  if (!credential) throw new BridgeError('native-model-catalog-unavailable', 'The original provider credential is unavailable.');
  const fingerprint = createHash('sha256').update(JSON.stringify([root, providerId, url.toString(), credential, cached.identity, cached.fetched_at])).digest('hex');
  let entry = nativeCatalogCache.get(fingerprint);
  if (!entry || entry.expires < Date.now()) {
    const value = (async () => {
      const response = await (options.fetch ?? fetch)(url.toString(), { headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new BridgeError('native-model-catalog-unavailable', 'The original provider catalog is unavailable.');
      const text = await response.text(); if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new BridgeError('native-model-catalog-unavailable', 'The original provider catalog exceeded its size limit.');
      const data = JSON.parse(text);
      if (Array.isArray(data.models)) return { raw: data.models, catalogSource: 'original-provider-catalog', imageModelAvailable: data.models.some((/** @type {Value} */ m) => (m.slug ?? m.id) === 'gpt-image-2.5-flare') };
      if (!Array.isArray(data.data)) throw new BridgeError('native-model-catalog-unavailable', 'The original provider returned no model catalog.');
      const ids = new Set(data.data.map((/** @type {Value} */ m) => m.id));
      // 只按原 provider 的实时 ID 授权；模型缓存来自其他账号时也不能引入不在此 provider 的候选项。
      return { raw: (Array.isArray(cached.models) ? cached.models : []).filter((/** @type {Value} */ m) => ids.has(m.slug ?? m.model ?? m.id)), catalogSource: 'provider-models+desktop-capabilities', imageModelAvailable: ids.has('gpt-image-2.5-flare') };
    })();
    entry = { expires: Date.now() + 300000, value }; nativeCatalogCache.set(fingerprint, entry);
    value.catch(() => { if (nativeCatalogCache.get(fingerprint)?.value === value) nativeCatalogCache.delete(fingerprint); });
  }
  const data = await entry.value;
  return { models: normaliseNativeCodexModels(data.raw, currentModel), catalogSource: data.catalogSource, imageModelAvailable: data.imageModelAvailable };
}
/** @param {unknown} raw @param {string} currentModel @returns {Value[]} */
export function normaliseNativeCodexModels(raw, currentModel) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(), result = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = item.slug ?? item.model ?? item.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || seen.has(id)) continue;
    if (item.visibility && item.visibility !== 'list' && id !== currentModel || item.hidden === true && id !== currentModel) continue;
    const levels = item.supported_reasoning_levels ?? item.supportedReasoningEfforts;
    const reasoningEfforts = Array.isArray(levels) ? [...new Set(levels.map(value => typeof value === 'string' ? value : value?.effort ?? value?.reasoningEffort).filter(value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,30}$/u.test(value)))] : [];
    if (!reasoningEfforts.length) continue;
    const requestedDefault = item.default_reasoning_level ?? item.defaultReasoningEffort;
    seen.add(id); result.push({ id, label: typeof item.display_name === 'string' ? item.display_name : typeof item.displayName === 'string' ? item.displayName : id,
      reasoningEfforts, defaultReasoningEffort: reasoningEfforts.includes(requestedDefault) ? requestedDefault : reasoningEfforts[0] });
  }
  return result;
}
