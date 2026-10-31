import { SessionStorage } from '../storage.mjs';
import { CodexBackend } from '../adapters/codex-backend.mjs';
import { discoverLocalAgents, createLocalAgentAdapter } from '../adapters/local-agent-discovery.mjs';
import { isCodeLightCodexSource } from './source-scope.mjs';

/** @typedef {Record<string,any>} Value */

/** Local discovery returns descriptions only; it never opens or starts any Agent. */
export class LocalSourceDiscovery {
  /** @param {{storage?:Pick<SessionStorage,'list'>,localWindows?:()=>Promise<Value[]>,createWindowAdapter?:(app:string)=>Value,codexBackend?:CodexBackend,allowDeferredSources?:boolean}} [options] */
  constructor(options = {}) {
    this.storage = options.storage ?? new SessionStorage(); this.windows = options.localWindows ?? (() => discoverLocalAgents());
    this.codex = options.codexBackend ?? new CodexBackend(); this.createWindowAdapter = options.createWindowAdapter ?? createLocalAgentAdapter;
    this.allowDeferredSources = options.allowDeferredSources === true;
    this.windowAdapters = /** @type {Map<string,Value>} */ (new Map());
  }
  async discover() {
    // 默认产品发现不触发窗口扫描；延期研究只能由内部构造参数显式启用。
    const result = await Promise.allSettled([this.storage.list('codex'), ...(this.allowDeferredSources ? [this.windows()] : [])]);
    /** @type {Value[]} */ const sources = [];
    /** @type {string[]} */ const errors = [];
    if (result[0].status === 'fulfilled' && Array.isArray(result[0].value)) for (const row of result[0].value) sources.push({ ...row, app: 'codex', hostId: 'local', kind: 'session', adapterKey: 'codex' });
    else errors.push('codex-index-unavailable');
    if (this.allowDeferredSources) {
      if (result[1].status === 'fulfilled') sources.push(...result[1].value); else errors.push('local-window-discovery-unavailable');
    }
    return { sources, errors };
  }
  /** @param {Value} source */
  adapter(source) {
    if (isCodeLightCodexSource(source, source.metadata)) return this.codex;
    if (!this.allowDeferredSources) throw Object.assign(Error('Only native Codex session sources are supported.'), { code: 'unsupported-source' });
    let adapter = this.windowAdapters.get(source.app);
    if (!adapter) { adapter = this.createWindowAdapter(source.app); this.windowAdapters.set(source.app, adapter); }
    return adapter;
  }
  async close() { await this.codex.dispose(); await Promise.allSettled([...this.windowAdapters.values()].map(adapter => adapter.dispose?.())); this.windowAdapters.clear(); }
}
