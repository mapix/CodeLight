import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_AGENT_CATALOG, createLocalAgentAdapter } from './local-agent-window.mjs';

/** @typedef {Record<string,any>} Value */
const execute = promisify(execFile);

/** @param {string} path */
async function exists(path) { try { await access(path); return true; } catch { return false; } }

/** Public executable identity only; never emit full argv, which may contain prompts or credentials. */
async function processes() {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
  return stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), executable: match[3] }] : [];
  });
}

/** @param {{applicationsDirectories?:string[],processes?:()=>Promise<Value[]>,readPlist?:(path:string)=>Promise<Value>}} [options] */
export async function inspectLocalAgents(options = {}) {
  const directories = options.applicationsDirectories ?? ['/Applications', join(homedir(), 'Applications'), '/System/Applications/Utilities'];
  const running = await (options.processes ?? processes)();
  const readPlist = options.readPlist ?? (async (/** @type {string} */ path) => {
    const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { maxBuffer: 256 * 1024, timeout: 5000 });
    return /** @type {Value} */ (JSON.parse(stdout));
  });
  const applications = await Promise.all(LOCAL_AGENT_CATALOG.map(async definition => {
    let applicationPath = null, metadata = null;
    for (const directory of directories) {
      const candidate = join(directory, definition.application);
      if (!await exists(join(candidate, 'Contents', 'Info.plist'))) continue;
      applicationPath = candidate;
      try { metadata = await readPlist(join(candidate, 'Contents', 'Info.plist')); } catch { metadata = null; }
      break;
    }
    const identityMatches = metadata?.CFBundleIdentifier === definition.bundleId;
    const executable = applicationPath && typeof metadata?.CFBundleExecutable === 'string' ? join(applicationPath, 'Contents', 'MacOS', metadata.CFBundleExecutable) : null;
    const mainProcesses = identityMatches && executable ? running.filter(process => process.executable === executable) : [];
    return { app: definition.app, name: definition.name, bundleId: definition.bundleId, applicationPath,
      installed: applicationPath !== null, identityMatches, version: metadata?.CFBundleShortVersionString ?? null,
      running: mainProcesses.length > 0, processes: mainProcesses.map(process => ({ pid: process.pid, parentPid: process.parentPid })),
      mode: 'native-window', sessionIdentityVerified: false,
      reason: applicationPath === null ? 'not-installed' : !identityMatches ? 'bundle-identity-mismatch' : mainProcesses.length === 0 ? 'agent-not-running' : null };
  }));
  const cliDefinitions = [
    { app: 'claude-code', name: 'Claude Code', candidates: [join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude'] },
    { app: 'opencode', name: 'OpenCode', candidates: [join(homedir(), '.opencode/bin/opencode'), '/opt/homebrew/bin/opencode', join(homedir(), '.local/bin/opencode')] },
    { app: 'aider', name: 'Aider', candidates: [join(homedir(), '.local/bin/aider'), '/opt/homebrew/bin/aider'] },
  ];
  const clis = await Promise.all(cliDefinitions.map(async definition => {
    let executable = null;
    for (const candidate of definition.candidates) if (await exists(candidate)) { executable = await realpath(candidate); break; }
    const matched = executable ? running.filter(process => process.executable === executable) : [];
    return { app: definition.app, name: definition.name, installed: executable !== null, executable,
      running: matched.length > 0, processes: matched.map(process => ({ pid: process.pid, parentPid: process.parentPid })),
      controlMode: 'inventory-only', sessionIdentityVerified: false, capabilities: { messages: false, interrupt: false, permissions: false },
      reason: 'active-cli-owner-api-unverified' };
  }));
  return { applications, clis };
}

/** @param {{includeUnavailable?:boolean,inventory?:Value,createAdapter?:(app:string)=>any}} [options] */
export async function discoverLocalAgents(options = {}) {
  const inventory = options.inventory ?? await inspectLocalAgents();
  /** @type {Value[]} */ const descriptors = [];
  for (const application of inventory.applications) {
    if (!application.installed || !application.identityMatches) continue;
    const backend = (options.createAdapter ?? createLocalAgentAdapter)(application.app);
    try {
      // 原 NSRunningApplication/AX probe 是窗口的事实；ps 库存只是诊断，不因 Helper 残留启动新进程。
      const status = await backend.status();
      const windows = status.running ? await backend.list() : [];
      for (const window of windows) descriptors.push({ ...window, app: application.app, adapterKey: application.app, hostId: 'local',
        installed: true, available: status.connected === true, capabilities: status.capabilities ?? null, controlMode: 'native-window', sessionIdentityVerified: false });
      if (windows.length === 0 && options.includeUnavailable !== false) descriptors.push({ app: application.app, adapterKey: application.app,
        id: 'app-window', hostId: 'local', title: `${application.name} · ${status.running ? '窗口不可用' : '未运行'}`, workspace: '桌面窗口', kind: 'window',
        installed: true, available: false, runtimeGeneration: status.runtimeGeneration ?? null, windowGeneration: null,
        reason: status.reason ?? 'window-unavailable', capabilities: { messages: false, interrupt: false, permissions: false, capture: false, textInput: false },
        controlMode: 'native-window', sessionIdentityVerified: false });
    } catch (error) {
      if (options.includeUnavailable !== false) descriptors.push({ app: application.app, adapterKey: application.app, id: 'app-window', hostId: 'local',
        title: `${application.name} · 无法读取原窗口`, workspace: '桌面窗口', kind: 'window', installed: true, available: false,
        runtimeGeneration: null, windowGeneration: null, reason: /** @type {Value} */ (error)?.code ?? 'window-unavailable',
        capabilities: { messages: false, interrupt: false, permissions: false, capture: false, textInput: false }, controlMode: 'native-window', sessionIdentityVerified: false });
    } finally { await backend.dispose(); }
  }
  return descriptors;
}

export { createLocalAgentAdapter, createLocalAgentAdapter as createAdapter, LOCAL_AGENT_CATALOG };
