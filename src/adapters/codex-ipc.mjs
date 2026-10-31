import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../errors.mjs';
import { validateNativeResponse } from './codex-response-schema.mjs';

/** @typedef {Record<string, any>} Frame */
/** @typedef {{sessionId:string,hostId:string,ownerClientId:string,supportsUntrustedAppInput:boolean}} Owner */
/** @typedef {{resolve:(value:Frame)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>,method:string,targetClientId?:string}} Pending */
/** @typedef {{callbacks:Set<(frame:Frame)=>void>,owner:Owner|null}} Subscription */

const VERSIONS = Object.freeze({
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-stream-state-changed': 11,
  'thread-stream-following-changed': 1,
  'thread-stream-following-status-requested': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-steer-turn': 1,
  'thread-follower-read-model-settings': 1,
  'thread-follower-update-thread-settings': 2,
  'thread-follower-interrupt-turn': 4,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-submit-user-input': 1,
  'thread-follower-submit-mcp-server-elicitation-response': 1,
  'thread-follower-permissions-request-approval-response': 1,
});

// 入站拒绝也要遵守已核验原生客户端的完整版本表；这不会扩大本客户端的出站命令能力。
const INBOUND_VERSIONS = Object.freeze({
  ...VERSIONS,
  'ipc-connection-reset': 1,
  'thread-read-state-changed': 3,
  'thread-archived': 2,
  'thread-unarchived': 1,
  'thread-follower-load-complete-history': 1,
  'thread-follower-compact-thread': 1,
  'thread-follower-update-daybreak': 1,
  'thread-follower-edit-last-user-turn': 2,
  'thread-follower-set-queued-follow-ups-state': 1,
  'thread-follower-remove-queued-message': 1,
  'thread-follower-clear-queued-messages': 1,
  'thread-queued-followups-changed': 2,
});

/** Native client request-version rules, including the supported local legacy interrupt.
 * @param {Frame} frame */
function matchesNativeRequestVersion(frame) {
  const version = frame.version ?? 0;
  const method = /** @type {keyof typeof INBOUND_VERSIONS} */ (frame.method);
  const base = Object.hasOwn(INBOUND_VERSIONS, method) ? INBOUND_VERSIONS[method] : 0;
  const expected = frame.hostId != null && method.startsWith('thread-follower-') ? base + 1 : base;
  return version === expected || frame.hostId == null && method === 'thread-follower-interrupt-turn' && version === 3;
}

/** Independent client of the existing desktop owner/follower IPC router. */
export class CodexIpcAdapter {
  /** @param {{socketPath?:string,hostId?:string,maxFrameBytes?:number,timeoutMs?:number,onStatus?:(frame:Frame)=>void}} [options] */
  constructor(options = {}) {
    this.socketPath = options.socketPath ?? join(homedir(), '.codex', 'ipc', 'ipc.sock');
    this.hostId = options.hostId ?? 'local';
    this.maxFrameBytes = options.maxFrameBytes ?? 32 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1 || this.maxFrameBytes > 256 * 1024 * 1024) {
      throw new BridgeError('invalid-frame-limit', 'Codex IPC frame limit must be between 1 byte and 256 MiB.');
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new BridgeError('invalid-timeout', 'Codex IPC timeout must be between 1 and 120000 milliseconds.');
    }
    this.onStatus = options.onStatus ?? (() => {});
    /** @type {net.Socket|null} */ this.socket = null;
    /** @type {Promise<void>|null} */ this.connecting = null;
    this.clientId = 'initializing-client';
    this.buffer = Buffer.alloc(0);
    /** @type {Map<string,Pending>} */ this.pending = new Map();
    /** @type {Map<string,Owner>} */ this.owners = new Map();
    /** @type {Map<string,Subscription>} */ this.subscriptions = new Map();
    /** @type {Map<string,{fingerprint:string,promise:Promise<Frame>}>} */ this.commands = new Map();
    this.disposed = false;
  }

  async connect() {
    if (this.disposed) throw new BridgeError('adapter-disposed', 'Codex adapter is disposed.', 503);
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed && this.clientId !== 'initializing-client') return;
    const operation = this.open();
    this.connecting = operation;
    try { await operation; } finally { if (this.connecting === operation) this.connecting = null; }
  }

  async open() {
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.clientId = 'initializing-client';
    socket.on('data', (chunk) => {
      if (this.socket !== socket) return;
      try { this.consume(chunk); } catch (error) { socket.destroy(asError(error)); }
    });
    socket.on('error', (error) => this.disconnect(socket, error));
    socket.on('close', () => this.disconnect(socket, new BridgeError('codex-disconnected', 'Existing Codex IPC connection closed.', 503)));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(new BridgeError('codex-connect-timeout', 'Codex IPC connection timed out.', 503)), this.timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(undefined); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      socket.once('close', () => { clearTimeout(timer); reject(new BridgeError('codex-disconnected', 'Codex IPC closed before connection was established.', 503)); });
    });
    const response = await this.request('initialize', { clientType: 'agent-session-bridge' });
    if (typeof response.result?.clientId !== 'string' || !response.result.clientId) {
      socket.destroy();
      throw new BridgeError('codex-protocol-error', 'Codex IPC returned no client identity.', 502);
    }
    this.clientId = response.result.clientId;
    this.emitStatus('connected');
    // 重连只恢复只读订阅；未知结果的写请求绝不能自动重放。
    for (const sessionId of this.subscriptions.keys()) {
      queueMicrotask(() => { this.attach(sessionId).catch((error) => this.emitStatus('subscription-error', sessionId, asError(error).message)); });
    }
  }

  /** @param {net.Socket} socket @param {Error} error */
  disconnect(socket, error) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.clientId = 'initializing-client';
    this.buffer = Buffer.alloc(0);
    this.owners.clear();
    for (const subscription of this.subscriptions.values()) subscription.owner = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emitStatus('disconnected', undefined, error.message);
  }

  /** @param {string} status @param {string} [sessionId] @param {string} [message] */
  emitStatus(status, sessionId, message) {
    const frame = { type: 'bridge/status', status, sessionId, message };
    this.onStatus(frame);
    for (const [id, subscription] of this.subscriptions) {
      if (sessionId === undefined || sessionId === id) for (const callback of subscription.callbacks) callback(frame);
    }
  }

  /** @param {Buffer} chunk */
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > this.maxFrameBytes) throw new BridgeError('codex-frame-too-large', 'Codex IPC frame exceeded the allowed size.', 502);
      if (this.buffer.length < length + 4) return;
      const json = this.buffer.subarray(4, length + 4).toString('utf8');
      this.buffer = this.buffer.subarray(length + 4);
      const frame = JSON.parse(json);
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new BridgeError('codex-protocol-error', 'Invalid Codex IPC frame.', 502);
      this.handle(frame);
    }
  }

  /** @param {Frame} frame */
  handle(frame) {
    if (frame.type === 'response') {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      this.pending.delete(frame.requestId);
      clearTimeout(pending.timer);
      if (frame.resultType === 'error') {
        pending.reject(new BridgeError('codex-request-rejected', String(frame.error ?? 'Codex IPC request rejected.'), 409));
      } else if (frame.resultType !== 'success' || frame.method !== pending.method ||
        (pending.targetClientId && frame.handledByClientId !== pending.targetClientId)) {
        pending.reject(new BridgeError('codex-protocol-error', 'Codex IPC response identity or method did not match.', 502));
      } else pending.resolve(frame);
      return;
    }
    if (frame.type === 'request') {
      if (typeof frame.requestId !== 'string' || !frame.requestId || typeof frame.method !== 'string' || !frame.method) {
        throw new BridgeError('codex-protocol-error', 'Codex IPC request identity or method was invalid.', 502);
      }
      // 原生客户端会明确拒绝转发来的未处理请求；静默丢弃会让请求方一直等到超时。
      // CodeLight 不注册 owner handler，所以合法版本也只能拒绝，不能借此承认或执行原会话操作。
      this.write({ type: 'response', requestId: frame.requestId, resultType: 'error',
        error: matchesNativeRequestVersion(frame) ? 'no-handler-for-request' : 'request-version-mismatch' });
      return;
    }
    if (frame.type === 'client-discovery-request') {
      this.write({ type: 'client-discovery-response', requestId: frame.requestId, response: { canHandle: false } });
      return;
    }
    if (frame.type !== 'broadcast') return;
    if (frame.method === 'client-status-changed') {
      if (frame.version !== 0) return;
      if (frame.params?.status === 'connected') {
        for (const [sessionId, subscription] of this.subscriptions) if (!subscription.owner) {
          this.attach(sessionId).catch((error) => this.emitStatus('owner-unavailable', sessionId, asError(error).message));
        }
        return;
      }
      if (frame.params?.status !== 'disconnected') return;
      for (const [sessionId, owner] of this.owners) if (owner.ownerClientId === frame.params.clientId) {
        this.owners.delete(sessionId);
        const subscription = this.subscriptions.get(sessionId);
        if (subscription) {
          subscription.owner = null;
          this.emitStatus('owner-disconnected', sessionId);
          this.attach(sessionId).catch((error) => this.emitStatus('owner-unavailable', sessionId, asError(error).message));
        }
      }
      return;
    }
    const sessionId = frame.params?.conversationId;
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription || frame.params?.hostId !== this.hostId || frame.sourceClientId !== subscription.owner?.ownerClientId) return;
    if (frame.targetClientIds != null && (!Array.isArray(frame.targetClientIds) || !frame.targetClientIds.includes(this.clientId))) return;
    if (frame.method !== 'thread-stream-state-changed' && frame.method !== 'thread-stream-following-changed') return;
    if (frame.version !== VERSIONS[/** @type {keyof typeof VERSIONS} */ (frame.method)]) {
      throw new BridgeError('codex-version-mismatch', 'Codex desktop IPC stream version is unsupported.', 502);
    }
    if (frame.method === 'thread-stream-state-changed' && !['snapshot', 'patches'].includes(frame.params?.change?.type)) {
      throw new BridgeError('codex-protocol-error', 'Unknown Codex stream change type.', 502);
    }
    for (const callback of subscription.callbacks) callback(frame);
  }

  /** @param {Frame} frame */
  write(frame) {
    if (!this.socket || this.socket.destroyed) throw new BridgeError('codex-disconnected', 'Existing Codex IPC connection is unavailable.', 503);
    const json = Buffer.from(JSON.stringify(frame), 'utf8');
    if (json.length === 0 || json.length > this.maxFrameBytes) throw new BridgeError('codex-frame-too-large', 'Codex IPC request exceeded the allowed size.');
    const frameBytes = Buffer.allocUnsafe(json.length + 4);
    frameBytes.writeUInt32LE(json.length, 0);
    json.copy(frameBytes, 4);
    this.socket.write(frameBytes);
  }

  /** @param {keyof typeof VERSIONS} method @param {Frame} params @param {string} [targetClientId] @returns {Promise<Frame>} */
  request(method, params, targetClientId) {
    const requestId = randomUUID();
    const remoteHost = method.startsWith('thread-follower-') && this.hostId !== 'local' ? this.hostId : undefined;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BridgeError('codex-outcome-unknown', 'Codex IPC response timed out; the operation will not be retried automatically.', 504));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method, targetClientId });
      try {
        this.write({ type: 'request', requestId, sourceClientId: this.clientId, version: VERSIONS[method] + (remoteHost ? 1 : 0),
          method, params, targetClientId, hostId: remoteHost, timeoutMs: this.timeoutMs });
      } catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  /** @param {string} sessionId @returns {Promise<Owner|null>} */
  async discover(sessionId) {
    requireId(sessionId, 'sessionId');
    await this.connect();
    const response = await this.request('thread-owner-discovery', { hostId: this.hostId, conversationId: sessionId }).catch((error) => {
      // 原 router 把发现拒绝与其内部超时都折叠成 no-client-found；null 仅表示未确认 owner，不是 idle 证据。
      if (error instanceof BridgeError && error.code === 'codex-request-rejected' && error.message === 'no-client-found') return null;
      if (error instanceof BridgeError && (error.code === 'codex-outcome-unknown' ||
        error.code === 'codex-request-rejected' && error.message === 'request-timeout')) {
        throw new BridgeError('codex-discovery-timeout', 'Desktop owner discovery timed out; the session status is unconfirmed.', 504);
      }
      throw error;
    });
    if (!response) { this.owners.delete(sessionId); return null; }
    if (typeof response.handledByClientId !== 'string' || !response.handledByClientId) throw new BridgeError('codex-protocol-error', 'Codex IPC owner discovery returned no owner.', 502);
    const owner = { sessionId, hostId: this.hostId, ownerClientId: response.handledByClientId, supportsUntrustedAppInput: response.result?.supportsUntrustedAppInput === true };
    this.owners.set(sessionId, owner);
    return owner;
  }

  /** @param {string} sessionId @param {(frame:Frame)=>void} onFrame */
  async subscribe(sessionId, onFrame) {
    requireId(sessionId, 'sessionId');
    let subscription = this.subscriptions.get(sessionId);
    if (!subscription) { subscription = { callbacks: new Set(), owner: null }; this.subscriptions.set(sessionId, subscription); }
    subscription.callbacks.add(onFrame);
    try { await this.attach(sessionId); } catch (error) {
      subscription.callbacks.delete(onFrame);
      if (!subscription.callbacks.size) this.subscriptions.delete(sessionId);
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscription.callbacks.delete(onFrame);
      if (subscription.callbacks.size) return;
      this.subscriptions.delete(sessionId);
      if (subscription.owner && this.socket && !this.socket.destroyed) this.follow(subscription.owner, false);
    };
  }

  /** @param {string} sessionId */
  async attach(sessionId) {
    const owner = await this.discover(sessionId);
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) return;
    if (!owner) throw new BridgeError('codex-owner-unavailable', 'An existing desktop owner could not be confirmed for this session.', 409);
    subscription.owner = owner;
    this.follow(owner, true);
  }

  /** Request a current read snapshot from the already attached owner. No owner discovery or runtime admission.
   * @param {string} sessionId */
  async refreshSnapshot(sessionId) {
    requireId(sessionId, 'sessionId');
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription?.owner || !this.socket || this.socket.destroyed) throw new BridgeError('codex-owner-unavailable', 'There is no existing subscribed owner to refresh.', 409);
    this.follow(subscription.owner, true);
  }

  /** @param {Owner} owner @param {boolean} following */
  follow(owner, following) {
    this.write({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.clientId,
      version: 1, targetClientIds: [owner.ownerClientId], params: { conversationId: owner.sessionId, hostId: owner.hostId, following } });
  }

  /** Stable identity of the already discovered owner; never creates one. @param {string} sessionId */
  generation(sessionId) {
    const owner = this.owners.get(sessionId);
    return owner ? `${owner.hostId}:${owner.ownerClientId}` : null;
  }

  /** @param {string} sessionId @param {keyof typeof VERSIONS} method @param {Frame} params @param {string} commandId @param {string|null} [expectedGeneration] @returns {Promise<Frame>} */
  command(sessionId, method, params, commandId, expectedGeneration) {
    requireId(sessionId, 'sessionId'); requireId(commandId, 'commandId');
    const key = JSON.stringify([this.hostId, sessionId, commandId]);
    const fingerprint = JSON.stringify([method, params, expectedGeneration ?? null]);
    const prior = this.commands.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return Promise.reject(new BridgeError('command-conflict', 'A command ID cannot be reused for different input.', 409));
      return prior.promise;
    }
    const promise = (async () => {
      const owner = await this.discover(sessionId);
      if (!owner) throw new BridgeError('codex-owner-unavailable', 'An existing desktop owner could not be confirmed for this session.', 409);
      // 上层 guard 之后 discovery 仍可能发现另一个 owner；旧动作必须固定原 epoch，不能随发现结果换目标。
      if (expectedGeneration != null && `${owner.hostId}:${owner.ownerClientId}` !== expectedGeneration) throw new BridgeError('source-epoch-changed', 'The original owner changed before native dispatch.', 409);
      return this.request(method, params, owner.ownerClientId);
    })();
    this.commands.set(key, { fingerprint, promise });
    return promise;
  }

  /** @param {string} sessionId @param {string} text @param {string} commandId @param {string|null} [expectedGeneration] */
  send(sessionId, text, commandId, expectedGeneration) {
    requireId(text, 'text');
    // 本地原 owner 的常规 turn/start 会继承会话设置；强制云端 admission 会在分配 turn ID 前被客户端拒绝。
    return this.command(sessionId, 'thread-follower-start-turn', { conversationId: sessionId,
      turnStart: { request: { threadId: sessionId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: commandId },
        context: { inheritThreadSettings: true } } }, commandId, expectedGeneration);
  }

  /** Read the original owner's settings, after its pending settings writes have completed.
   * @param {string} sessionId @param {string|null} [expectedGeneration] */
  async readModelSettings(sessionId, expectedGeneration) {
    const owner = await this.discover(sessionId);
    if (!owner) throw new BridgeError('codex-owner-unavailable', 'An existing desktop owner could not be confirmed for this session.', 409);
    if (expectedGeneration != null && this.generation(sessionId) !== expectedGeneration) throw new BridgeError('source-epoch-changed', 'The original owner changed before settings were read.', 409);
    const response = await this.request('thread-follower-read-model-settings', { conversationId: sessionId }, owner.ownerClientId);
    const settings = response.result?.settings;
    if (!settings || typeof settings.model !== 'string' || !settings.model.trim() || settings.reasoningEffort != null && typeof settings.reasoningEffort !== 'string') throw new BridgeError('native-settings-unavailable', 'The original model settings are unavailable.', 409);
    return { model: settings.model, reasoningEffort: settings.reasoningEffort ?? null, modelProvider: typeof settings.modelProvider === 'string' ? settings.modelProvider : null };
  }

  /** The original owner updates persisted thread settings; an active turn is never rewritten or interrupted.
   * @param {string} sessionId @param {{model:string,reasoningEffort:string|null,expectedModel:string,expectedReasoningEffort:string|null}} settings
   * @param {string} commandId @param {string|null} [expectedGeneration] */
  updateModelSettings(sessionId, settings, commandId, expectedGeneration) {
    if (typeof settings.model !== 'string' || !settings.model.trim() || typeof settings.expectedModel !== 'string' || !settings.expectedModel.trim() ||
        settings.reasoningEffort != null && typeof settings.reasoningEffort !== 'string' || settings.expectedReasoningEffort != null && typeof settings.expectedReasoningEffort !== 'string') throw new BridgeError('invalid-settings', 'Explicit original and requested model settings are required.');
    // 原接口 activeTurnId 非 null 时走权限更新；模型/effort 必须走原 owner 的 thread settings 分支。
    return this.command(sessionId, 'thread-follower-update-thread-settings', { conversationId: sessionId,
      threadSettings: { model: settings.model, effort: settings.reasoningEffort }, activeTurnId: null,
      condition: { ifModelEquals: settings.expectedModel, ifEffortEquals: settings.expectedReasoningEffort } }, commandId, expectedGeneration);
  }

  /** Targets the owner's current active turn, as defined by the native IPC schema.
   * @param {string} sessionId @param {string} text @param {string} commandId @param {string|null} [expectedGeneration] */
  steer(sessionId, text, commandId, expectedGeneration) {
    requireId(text, 'text');
    // 原桌面 rr(input) 先读 text_elements.length；API start 会补默认值，follower steer 进入 owner 前必须自行归一化。
    return this.command(sessionId, 'thread-follower-steer-turn', { conversationId: sessionId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: commandId,
      restoreMessage: { context: { prompt: text, commentAttachments: [] } } }, commandId, expectedGeneration);
  }

  /** @param {{sessionId:string,hostId:string,turnId:string}} target @param {string} commandId @param {string|null} [expectedGeneration] */
  interrupt(target, commandId, expectedGeneration) {
    this.assertHost(target.hostId); requireId(target.turnId, 'turnId');
    return this.command(target.sessionId, 'thread-follower-interrupt-turn', { conversationId: target.sessionId, mode: 'user-stop', expectedTurnId: target.turnId }, commandId, expectedGeneration);
  }

  /** @param {{sessionId:string,hostId:string,requestId:string|number,kind:'command'|'file'}} target @param {'accept'|'decline'|'cancel'} decision @param {string} commandId @param {string|null} [expectedGeneration] */
  respondApproval(target, decision, commandId, expectedGeneration) {
    this.assertHost(target.hostId);
    if (!['command', 'file'].includes(target.kind) || !['accept', 'decline', 'cancel'].includes(decision) ||
      !((typeof target.requestId === 'string' && target.requestId.length > 0) || Number.isSafeInteger(target.requestId))) {
      throw new BridgeError('unsupported-approval', 'A native command/file request identity and supported decision are required.');
    }
    const method = target.kind === 'command' ? 'thread-follower-command-approval-decision' : 'thread-follower-file-approval-decision';
    return this.command(target.sessionId, method, { conversationId: target.sessionId, requestId: target.requestId, decision }, commandId, expectedGeneration);
  }

  /** @param {{sessionId:string,hostId:string,requestId:string|number}} target @param {unknown} response @param {string} commandId @param {string|null} [expectedGeneration] */
  respondUserInput(target, response, commandId, expectedGeneration) { return this.respondNative('user-input', target, response, commandId, expectedGeneration); }
  /** @param {{sessionId:string,hostId:string,requestId:string|number}} target @param {unknown} response @param {string} commandId @param {string|null} [expectedGeneration] */
  respondElicitation(target, response, commandId, expectedGeneration) { return this.respondNative('elicitation', target, response, commandId, expectedGeneration); }
  /** @param {{sessionId:string,hostId:string,requestId:string|number}} target @param {unknown} response @param {string} commandId @param {string|null} [expectedGeneration] */
  respondPermissions(target, response, commandId, expectedGeneration) { return this.respondNative('permissions', target, response, commandId, expectedGeneration); }

  /** @param {'user-input'|'elicitation'|'permissions'} kind @param {{sessionId:string,hostId:string,requestId:string|number}} target @param {unknown} response @param {string} commandId @param {string|null} [expectedGeneration] */
  async respondNative(kind, target, response, commandId, expectedGeneration) {
    this.assertHost(target.hostId); requireId(target.sessionId, 'sessionId'); requireId(commandId, 'commandId');
    if (!((typeof target.requestId === 'string' && target.requestId.length > 0) || (typeof target.requestId === 'number' && Number.isSafeInteger(target.requestId)))) {
      throw new BridgeError('invalid-request-id', 'A native request identity is required.');
    }
    const value = await validateNativeResponse(kind, response);
    const methods = /** @type {const} */ ({ 'user-input': 'thread-follower-submit-user-input', elicitation: 'thread-follower-submit-mcp-server-elicitation-response', permissions: 'thread-follower-permissions-request-approval-response' });
    return this.command(target.sessionId, methods[kind], { conversationId: target.sessionId, requestId: target.requestId, response: value }, commandId, expectedGeneration);
  }

  /** @param {string} hostId */
  assertHost(hostId) {
    if (hostId !== this.hostId) throw new BridgeError('host-mismatch', 'Codex operation targets a different host.');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.owner && this.socket && !this.socket.destroyed) {
        try { this.follow(subscription.owner, false); } catch { /* 断连时原 owner 自动移除 follower。 */ }
      }
    }
    this.subscriptions.clear();
    this.socket?.destroy();
  }
}

/** @param {unknown} value @param {string} name */
function requireId(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new BridgeError('invalid-input', `${name} must be a nonempty string.`);
}
/** @param {unknown} error */
function asError(error) { return error instanceof Error ? error : new Error(String(error)); }
