import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError } from '../errors.mjs';
import { ZCodeAxBackend } from './zcode-ax.mjs';

/** @typedef {Record<string,any>} Value */
/** @typedef {{binaryPath?:string,screenshotDir?:string,pollMs?:number,timeoutMs?:number,native?:(request:Value)=>Promise<Value>}} WindowOptions */

export const LOCAL_AGENT_CATALOG = Object.freeze([
  { app: 'zcode', name: 'ZCode', bundleId: 'dev.zcode.app', application: 'ZCode.app', terminal: false },
  { app: 'claude-desktop', name: 'Claude Desktop', bundleId: 'com.anthropic.claudefordesktop', application: 'Claude.app', terminal: false },
  { app: 'cursor', name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', application: 'Cursor.app', terminal: false },
  { app: 'antigravity', name: 'Antigravity', bundleId: 'com.google.antigravity', application: 'Antigravity.app', terminal: false },
  { app: 'windsurf', name: 'Windsurf', bundleId: 'com.exafunction.windsurf', application: 'Windsurf.app', terminal: false },
  { app: 'vscode', name: 'VS Code', bundleId: 'com.microsoft.VSCode', application: 'Visual Studio Code.app', terminal: false },
  { app: 'zed', name: 'Zed', bundleId: 'dev.zed.Zed', application: 'Zed.app', terminal: false },
  { app: 'trae', name: 'Trae', bundleId: 'com.trae.app', application: 'Trae.app', terminal: false },
  { app: 'terminal', name: 'Terminal', bundleId: 'com.apple.Terminal', application: 'Terminal.app', terminal: true },
  { app: 'iterm', name: 'iTerm', bundleId: 'com.googlecode.iterm2', application: 'iTerm.app', terminal: true },
  { app: 'warp', name: 'Warp', bundleId: 'dev.warp.Warp-Stable', application: 'Warp.app', terminal: true },
]);

/** @param {string} app */
export function localAgentDefinition(app) {
  const definition = LOCAL_AGENT_CATALOG.find(item => item.app === app);
  if (!definition) throw new BridgeError('unsupported-local-agent', 'This local application has no verified window adapter.');
  return definition;
}

/** The original app owns its runtime; this adapter owns only observations and guarded window actions. */
export class LocalAgentWindowBackend extends ZCodeAxBackend {
  /** @param {string} app @param {WindowOptions} [options] */
  constructor(app, options = {}) {
    const definition = localAgentDefinition(app);
    super({ ...options, screenshotDir: options.screenshotDir ?? join(fileURLToPath(new URL('../../data/local-agent-window-images/', import.meta.url)), app) });
    this.app = definition.app; this.displayName = definition.name; this.bundleId = definition.bundleId;
    this.terminal = definition.terminal;
    /** @type {Value|null} */ this.lastProbe = null;
  }

  /** @param {boolean} [includeTitles] */
  async probe(includeTitles = false) { const value = await super.probe(includeTitles); this.lastProbe = value; return value; }

  /** @returns {Promise<Awaited<ReturnType<ZCodeAxBackend['status']>> & Value>} */
  async status() {
    const status = await super.status();
    const accessible = status.permissions?.accessibility === true;
    const hasWindow = this.lastProbe && this.windowCandidates(this.lastProbe).length > 0;
    const connected = status.connected === true && hasWindow === true;
    return /** @type {Awaited<ReturnType<ZCodeAxBackend['status']>> & Value} */ ({ ...status, connected, app: this.app, displayName: this.displayName, bundleId: this.bundleId,
      reason: status.reason === 'zcode-not-running' ? 'agent-not-running' : status.running === true && !hasWindow ? 'window-unavailable' : status.reason,
      sessionIdentityVerified: false, controlMode: 'native-window',
      capabilities: { session: false, messages: false, interrupt: false, permissions: false,
        capture: connected, coordinateControl: connected && accessible,
        semanticControl: connected && accessible, textInput: connected && accessible && !this.terminal } });
  }

  async list() {
    const windows = await super.list();
    return windows.map(window => ({ ...window, app: this.app, hostId: 'local', adapterKey: this.app,
      title: window.title.startsWith('ZCode · 窗口 ') ? `${this.displayName} · 窗口 ${window.windowId}` : window.title,
      sessionIdentityVerified: false, controlMode: 'native-window' }));
  }

  /** @param {string} id @param {Value} probe */
  resolveWindow(id, probe) {
    if (!probe.running) throw new BridgeError('agent-not-running', `${this.displayName} is not running. Open the original application explicitly.`, 503);
    try { return super.resolveWindow(id, probe); }
    catch (error) {
      if (error instanceof BridgeError && ['choose-window', 'window-missing'].includes(error.code))
        throw new BridgeError(error.code, error.code === 'choose-window' ? `Choose one original ${this.displayName} window.` : `The selected ${this.displayName} window is unavailable.`, 409);
      throw error;
    }
  }

  /** @param {string} id */
  async readWindow(id) {
    const original = await super.readWindow(id).catch(error => { throw this.windowFailure(error); });
    const view = /** @type {Value} */ (original);
    const accessible = this.lastProbe?.permissions?.accessibility === true;
    const controls = view.controls ?? [];
    const emptyInputs = controls.some((/** @type {Value} */ node) => ['AXTextArea', 'AXTextField', 'AXComboBox'].includes(node.role)
      && node.valueSettable === true && node.enabled !== false && node.text?.value === '');
    const actionable = controls.some((/** @type {Value} */ node) => node.enabled !== false
      && ((node.actions ?? []).includes('AXPress') || node.valueSettable === true));
    return { ...original, app: this.app, displayName: this.displayName, bundleId: this.bundleId,
      semanticControlAvailable: accessible && actionable, coordinateControlAvailable: view.coordinateControlAvailable && accessible && this.lastProbe?.permissions?.postEvents === true,
      textInputAvailable: accessible && !this.terminal && emptyInputs, sessionIdentityVerified: false, currentTurnId: null, rows: [], requests: [] };
  }

  /** @param {string} id @param {string} action @param {Value} payload @param {string} commandId */
  async command(id, action, payload, commandId) {
    // 原应用/CLI 的活跃会话不从 bridge 启动；终端 scrollback 也不能被当作可覆写的空草稿。
    if (action === 'launch') throw new BridgeError('explicit-app-open-required', `Open the original ${this.displayName} application on the Mac first.`, 409);
    if (this.terminal && action === 'type') throw new BridgeError('terminal-input-unverified', 'Terminal text entry has no verified empty Agent draft or session owner; it is disabled.', 409);
    try { return await super.command(id, action, payload, commandId); } catch (error) { throw this.windowFailure(error); }
  }

  /** @param {unknown} error */
  windowFailure(error) {
    if (!(error instanceof BridgeError) || !error.message.includes('ZCode')) return error;
    // 复用同一原窗口安全机制时仅修正错误中的产品名，不改变原错误码、effect 或重试语义。
    const mapped = new BridgeError(error.code, error.message.replace(/ZCode/gu, this.displayName), error.status);
    if ('nativeCause' in error) Object.assign(mapped, { nativeCause: error.nativeCause });
    return mapped;
  }
}

/** @param {string} app @param {WindowOptions} [options] */
export function createLocalAgentAdapter(app, options = {}) {
  localAgentDefinition(app);
  return app === 'zcode' ? new ZCodeAxBackend(options) : new LocalAgentWindowBackend(app, options);
}

export const createAdapter = createLocalAgentAdapter;
