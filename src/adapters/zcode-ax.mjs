import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string, any>} Value */
/** @typedef {{callbacks:Set<(view:Value)=>void>,timer:ReturnType<typeof setTimeout>|null,active:boolean}} Subscription */

/** Controls the existing ZCode application window. A window is never represented as a native session id. */
export class ZCodeAxBackend {
  /** @param {{binaryPath?:string,screenshotDir?:string,pollMs?:number,timeoutMs?:number,native?:(request:Value)=>Promise<Value>}} [options] */
  constructor(options = {}) {
    this.binaryPath = options.binaryPath ?? fileURLToPath(new URL('../../native/bin/macos-ax-control', import.meta.url));
    this.screenshotDir = options.screenshotDir ?? fileURLToPath(new URL('../../data/zcode-window-images', import.meta.url));
    this.pollMs = options.pollMs ?? 750;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.native = options.native ?? ((request) => invokeNative(this.binaryPath, request, this.timeoutMs));
    this.bundleId = 'dev.zcode.app';
    this.disposed = false;
    this.tail = Promise.resolve();
    this.revision = 0;
    /** @type {Map<string,Subscription>} */ this.subscriptions = new Map();
    /** @type {Map<string,string[]>} */ this.images = new Map();
    /** @type {Map<string,{digest:string,flight:Promise<Value>}>} */ this.commands = new Map();
    /** @type {Map<number,Value>} */ this.bindings = new Map();
  }

  /** @param {()=>Promise<Value>} operation @returns {Promise<Value>} */
  serialize(operation) {
    if (this.disposed) return Promise.reject(new BridgeError('adapter-disposed', 'ZCode adapter is disposed.', 503));
    const flight = this.tail.catch(() => {}).then(operation);
    this.tail = flight.then(() => {}, () => {});
    return flight;
  }

  /** @param {boolean} [includeTitles] */
  async probe(includeTitles = false) {
    const result = await this.native({ operation: 'probe', bundleId: this.bundleId, includeText: includeTitles });
    if ((result.sessionAccess && (result.sessionAccess.screenLocked || !result.sessionAccess.lockStateKnown)) || result.windowUIAvailable === false) await this.clearImages();
    return result;
  }

  async clearImages() {
    for (const images of this.images.values()) for (const path of images) await unlink(path).catch(() => {});
    this.images.clear();
    const files = await readdir(this.screenshotDir).catch(() => []);
    for (const name of files) if (/^window-[a-f0-9-]{36}\.png$/.test(name)) await unlink(join(this.screenshotDir, name)).catch(() => {});
  }

  /** @param {Value} probe */
  requireUnlocked(probe) {
    if (probe.sessionAccess && (probe.sessionAccess.screenLocked || !probe.sessionAccess.lockStateKnown)) {
      const known = probe.sessionAccess.lockStateKnown === true;
      throw new BridgeError(known ? 'screen-locked' : 'gui-session-unavailable', known ? 'The Mac screen is locked.' : 'The GUI session state cannot be confirmed.', 423);
    }
  }

  async status() {
    try {
      const value = await this.probe();
      const locked = value.sessionAccess && (value.sessionAccess.screenLocked || !value.sessionAccess.lockStateKnown);
      return { connected: value.running === true && value.permissions?.screenCapture === true && !locked && value.windowUIAvailable !== false,
        mode: 'accessibility-window', running: value.running === true, permissions: value.permissions,
        screenLocked: value.sessionAccess?.lockStateKnown === false ? null : !!locked,
        windowUIAvailable: value.windowUIAvailable !== false,
        runtimeGeneration: value.runtimeGeneration ?? null,
        reason: locked ? value.sessionAccess?.lockStateKnown === false ? 'gui-session-unavailable' : 'screen-locked' : !value.running ? 'zcode-not-running' : value.windowUIAvailable === false ? 'window-ui-unavailable' : !value.permissions?.screenCapture ? 'screen-capture-required' : null };
    } catch (error) { return { connected: false, mode: 'accessibility-window', reason: error instanceof BridgeError ? error.code : 'zcode-unavailable' }; }
  }

  /** @param {Value} value @returns {Value[]} */
  windowCandidates(value) {
    if (value.sessionAccess && (value.sessionAccess.screenLocked || !value.sessionAccess.lockStateKnown)) return [];
    if (!Array.isArray(value.windows)) return [];
    const axWindows = (value.axWindowInventory?.windows ?? []).filter((/** @type {Value} */ item) => item.bounds);
    return value.windows.filter((/** @type {Value} */ window) => window.applicationWindow === true ||
      (window.bounds?.width >= 200 && window.bounds?.height >= 100 && axWindows.some((/** @type {Value} */ ax) => boundsEqual(ax.bounds, window.bounds))));
  }

  async list() {
    const value = await this.probe(true);
    return this.windowCandidates(value).map((window) => ({ app: 'zcode', id: `window_${window.windowId}`,
      title: typeof window.title === 'string' && window.title ? window.title : `ZCode · 窗口 ${window.windowId}`, workspace: '桌面窗口', updatedAt: Date.now(), kind: 'window',
      windowId: window.windowId, runtimeGeneration: value.runtimeGeneration, windowGeneration: window.windowGeneration, bounds: window.bounds }));
  }

  /** @param {string} id @param {Value} probe */
  resolveWindow(id, probe) {
    if (!probe.running) throw new BridgeError('zcode-not-running', 'ZCode is not running. Start it explicitly.', 503);
    const windows = this.windowCandidates(probe);
    if (id === 'app-window') {
      if (windows.length !== 1) throw new BridgeError('choose-window', 'Select a specific ZCode window.', 409);
      return windows[0];
    }
    const match = /^(?:window_|window:)([1-9]\d*)$/.exec(id);
    const window = match && windows.find((item) => item.windowId === Number(match[1]));
    if (!window) throw new BridgeError('window-missing', 'The selected ZCode window is unavailable.', 409);
    return window;
  }

  /** @param {string} id @returns {Promise<Value>} */
  async snapshot(id = 'app-window') { return this.serialize(() => this.readWindow(id)); }

  /** @param {string} id */
  async readWindow(id) {
    await mkdir(this.screenshotDir, { recursive: true, mode: 0o700 });
    const probe = await this.probe();
    this.requireUnlocked(probe);
    if (probe.windowUIAvailable === false) throw new BridgeError('window-ui-unavailable', 'Show the existing ZCode window before viewing or controlling it.', 423);
    const window = this.resolveWindow(id, probe);
    const logical = probe.mainWindowBounds;
    const physicalMatches = (probe.axWindowInventory?.windows ?? []).some((/** @type {Value} */ item) => boundsEqual(item.bounds, window.bounds));
    const namedWindows = this.windowCandidates(probe).filter((item) => item.applicationWindow === true);
    let binding = this.bindings.get(window.windowId);
    if (binding?.runtimeGeneration && binding.runtimeGeneration !== probe.runtimeGeneration) {
      this.bindings.delete(window.windowId); binding = undefined;
    }
    if (!binding && namedWindows.length === 1 && probe.mainWindowHash) binding = { axWindowHash: probe.mainWindowHash };
    const axOnly = !physicalMatches && binding;
    const result = await this.native({ operation: axOnly ? 'axSnapshot' : 'mirror', bundleId: this.bundleId, pid: probe.pid,
      windowId: window.windowId, expectedRuntimeGeneration: probe.runtimeGeneration,
      expectedWindowGeneration: window.windowGeneration, captureStamp: axOnly ? binding : undefined, outputDirectory: this.screenshotDir });
    if (result.captureStamp?.axWindowHash) this.bindings.set(window.windowId, result.captureStamp);
    if (typeof result.imagePath !== 'string' && result.captureMode !== 'ax-only') throw new BridgeError('mirror-unavailable', 'ZCode window capture is unavailable.', 503);
    const key = `window_${window.windowId}`;
    const previous = this.images.get(key) ?? [];
    if (typeof result.imagePath === 'string') { previous.push(result.imagePath); this.images.set(key, previous); }
    while (previous.length > 4) await unlink(/** @type {string} */ (previous.shift())).catch(() => {});
    return { ...result, logicalBounds: result.logicalBounds ?? logical ?? window.bounds, physicalBounds: window.bounds,
      coordinateControlAvailable: result.captureMode !== 'ax-only', semanticControlAvailable: true,
      // 是否可以填入文本必须来自实际空可编辑控件；按钮名称或已安装 App 不能证明存在 Agent 草稿。
      textInputAvailable: probe.permissions?.accessibility === true && (result.controls ?? []).some((/** @type {Value} */ node) =>
        ['AXTextArea', 'AXTextField', 'AXComboBox'].includes(node.role) && node.valueSettable === true && node.enabled !== false && node.text?.value === ''),
      app: 'zcode', id: key, kind: 'window', windows: this.windowCandidates(probe),
      revision: ++this.revision, status: 'window-mirror', rows: [], requests: [], currentTurnId: null,
      sessionIdentityVerified: false, controlMode: 'native-window' };
  }

  /** @param {string} id @param {(view:Value)=>void} onView */
  async subscribe(id, onView) {
    let subscription = this.subscriptions.get(id);
    if (!subscription) {
      subscription = { callbacks: new Set(), timer: null, active: true };
      this.subscriptions.set(id, subscription);
    }
    subscription.callbacks.add(onView);
    try { onView(await this.snapshot(id)); }
    catch (error) { subscription.callbacks.delete(onView); if (!subscription.callbacks.size) this.stopSubscription(id, subscription); throw error; }
    this.schedule(id, subscription);
    let active = true;
    return () => {
      if (!active) return;
      active = false; subscription.callbacks.delete(onView);
      if (!subscription.callbacks.size) this.stopSubscription(id, subscription);
    };
  }

  /** @param {string} id @param {Subscription} subscription */
  schedule(id, subscription) {
    if (!subscription.active || subscription.timer || this.disposed) return;
    subscription.timer = setTimeout(async () => {
      subscription.timer = null;
      try {
        const view = await this.snapshot(id);
        if (subscription.active) for (const callback of subscription.callbacks) { try { callback(structuredClone(view)); } catch { /* Isolate closed phone consumers. */ } }
      } catch (error) {
        if (subscription.active) for (const callback of subscription.callbacks) { try { callback({ kind: 'window', status: 'unavailable',
          reason: error instanceof BridgeError ? error.code : 'mirror-unavailable', imagePath: null, captureStamp: null, controls: [], windows: [],
          screenLocked: error instanceof BridgeError && ['screen-locked', 'screen_locked'].includes(error.code), rows: [], requests: [], currentTurnId: null }); } catch { /* Isolate callbacks. */ } }
      }
      this.schedule(id, subscription);
    }, this.pollMs);
    subscription.timer.unref();
  }

  /** @param {string} id @param {Subscription} subscription */
  stopSubscription(id, subscription) {
    subscription.active = false;
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.timer = null;
    if (this.subscriptions.get(id) === subscription) this.subscriptions.delete(id);
  }

  /** @param {string} id @param {string} action @param {Value} payload @param {string} commandId @returns {Promise<Value>} */
  async command(id, action, payload, commandId) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(commandId)) throw new BridgeError('invalid-command-id', 'A stable command id is required.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new BridgeError('invalid-payload', 'A native control payload is required.');
    const payloadFields = new Set(['runtimeGeneration', 'windowGeneration', 'captureStamp', 'nodeId', 'text', 'key', 'x', 'y', 'deltaY']);
    if (Object.keys(payload).some((key) => !payloadFields.has(key))) throw new BridgeError('invalid-payload', 'Unknown native control payload field.');
    if (!['launch', 'activate', 'enableAccessibility', 'press', 'click', 'type', 'key', 'scroll'].includes(action)) {
      throw new BridgeError('unsupported-window-action', 'Use the actual ZCode window controls.');
    }
    const key = `${id}:${commandId}`;
    const digest = createHash('sha256').update(JSON.stringify({ action, payload })).digest('hex');
    const saved = this.commands.get(key);
    if (saved) {
      if (saved.digest !== digest) throw new BridgeError('command-conflict', 'The command id was reused for different content.', 409);
      return saved.flight;
    }
    if (this.commands.size >= 1024) throw new BridgeError('receipt-capacity', 'The native command receipt limit was reached.', 503);
    const flight = this.serialize(async () => {
      const probe = await this.probe();
      this.requireUnlocked(probe);
      if (action === 'launch') return this.native({ operation: action, bundleId: this.bundleId, id: commandId });
      const expectedRuntime = payload.runtimeGeneration ?? payload.captureStamp?.runtimeGeneration;
      if (typeof expectedRuntime !== 'string' || expectedRuntime !== probe.runtimeGeneration) throw new BridgeError('stale-runtime', 'ZCode restarted; refresh before acting.', 409);
      if (action === 'enableAccessibility') return this.native({ operation: action, id: commandId,
        bundleId: this.bundleId, pid: probe.pid, expectedRuntimeGeneration: expectedRuntime });
      if (action === 'activate' && id === 'app-window' && !payload.captureStamp && !payload.windowGeneration) {
        return this.native({ operation: 'activateApp', id: commandId, bundleId: this.bundleId, pid: probe.pid,
          expectedRuntimeGeneration: expectedRuntime });
      }
      const stamp = payload.captureStamp;
      const semantic = (['press', 'type'].includes(action) || action === 'key' && typeof payload.nodeId === 'string') && Number.isSafeInteger(stamp?.axWindowHash);
      const match = /^(?:window_|window:)([1-9]\d*)$/.exec(id);
      const rawWindow = semantic && match && probe.windows?.find((/** @type {Value} */ item) => item.windowId === Number(match[1]));
      const window = rawWindow || this.resolveWindow(id, probe);
      const expectedWindow = payload.windowGeneration ?? stamp?.windowGeneration;
      if (expectedWindow !== window.windowGeneration) throw new BridgeError('stale-window', 'The ZCode window changed; refresh before acting.', 409);
      if (['press', 'click', 'type', 'key', 'scroll'].includes(action)) {
        if (!stamp || ['runtimeGeneration', 'windowGeneration', 'layoutGeneration', 'imageLayoutHash'].some((name) => typeof stamp[name] !== 'string') || (!semantic && !boundsEqual(stamp.bounds, window.bounds))) {
          throw new BridgeError('capture-stamp-required', 'A current screenshot and control-layout stamp is required.', 409);
        }
      }
      if (['click', 'scroll'].includes(action) && (!Number.isFinite(payload.x) || !Number.isFinite(payload.y) ||
          payload.x < 0 || payload.y < 0 || payload.x >= window.bounds.width || payload.y >= window.bounds.height)) {
        throw new BridgeError('outside-window', 'The requested point is outside the ZCode window.');
      }
      if (action === 'type' && (typeof payload.nodeId !== 'string' || typeof payload.text !== 'string' || !payload.text || payload.text.length > 8000)) {
        throw new BridgeError('invalid-text', 'Choose a real empty input and provide bounded text.');
      }
      const allowed = ['captureStamp', 'nodeId', 'text', 'key', 'x', 'y', 'deltaY'];
      const nativePayload = Object.fromEntries(allowed.filter((name) => payload[name] !== undefined).map((name) => [name, payload[name]]));
      return this.native({ ...nativePayload, operation: action, id: commandId, bundleId: this.bundleId, pid: probe.pid,
        windowId: window.windowId, expectedRuntimeGeneration: expectedRuntime, expectedWindowGeneration: expectedWindow,
        outputDirectory: this.screenshotDir });
    });
    this.commands.set(key, { digest, flight });
    return flight;
  }

  async dispose() {
    this.disposed = true;
    for (const [id, subscription] of this.subscriptions) this.stopSubscription(id, subscription);
    await this.tail.catch(() => {});
    await this.clearImages();
  }
}

/** @param {Value|undefined} a @param {Value|undefined} b */
function boundsEqual(a, b) { return !!a && !!b && ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= 1); }

/** @param {string} binary @param {Value} request @param {number} timeoutMs @returns {Promise<Value>} */
export function invokeNative(binary, request, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false, spawned = false;
    const isAction = !['probe', 'mirror', 'axSnapshot'].includes(request.operation);
    const fail = (/** @type {string} */ code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      reject(new BridgeError(code, 'The native ZCode operation did not complete.', code === 'delivery-unknown' ? 502 : 503));
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(isAction && spawned ? 'delivery-unknown' : 'native-timeout'); }, timeoutMs);
    child.on('spawn', () => { spawned = true; });
    child.on('error', () => fail('native-helper-unavailable'));
    child.stdin.on('error', () => fail(isAction && spawned ? 'delivery-unknown' : 'native-helper-unavailable'));
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 8 * 1024 * 1024) { child.kill('SIGKILL'); fail(isAction ? 'delivery-unknown' : 'native-response-limit'); }
    });
    child.stderr.resume();
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.ok !== true) throw Object.assign(new BridgeError(result.effectMayHaveOccurred === true ? 'delivery-unknown' : result.error?.code ?? (isAction ? 'delivery-unknown' : 'native-read-failed'),
          result.error?.message ?? 'The native operation failed.', 409), { nativeCause: result.error?.cause ?? result.error?.code });
        resolve(result.result);
      } catch (error) { reject(error instanceof BridgeError ? error : new BridgeError(isAction ? 'delivery-unknown' : 'native-response-invalid', 'The native response is unavailable.', 502)); }
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}
