import { randomUUID } from 'node:crypto';
import { CodexActivityObserver } from '../adapters/codex-activity.mjs';
import { CodexIpcAdapter } from '../adapters/codex-ipc.mjs';
import { BridgeError } from '../errors.mjs';
import { isCodeLightCodexSource } from './source-scope.mjs';

/** @typedef {Record<string, any>} Value */
/** @typedef {{id:string,nativeId:string|null}} SessionRow */
/** @typedef {{id:string,projectKey:string,hostId:string,sessions?:SessionRow[]}} Group */
/** @typedef {{requestSeq:number,fingerprint:string,groups:Group[],expiresAt:number,retainUntil:number}} Interest */
/** @typedef {{source:Value,observer:Value,starting:boolean,queued:boolean,closed:boolean}} Entry */
const MAX_CLIENTS = 256;
const TOMBSTONE_MS = 120000;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_SESSION_ROWS = 64;

/** @param {unknown} value @param {number} limit */
function validString(value, limit) { return typeof value === 'string' && !!value.trim() && value.length <= limit; }
/** Legacy local session records preserve their native fallback; explicit other modes do not.
 * @param {Value} source */
function nativeSource(source) {
  // 多处显式 mode 必须分别满足 native 边界；null 或别处的 session 不能掩盖不支持的元数据。
  return isCodeLightCodexSource(source, source) && isCodeLightCodexSource(source, source.metadata) && (source.kind === undefined || source.kind === 'session') &&
    typeof source.id === 'string' && !!source.id && source.id.length <= 512 && source.available !== false && source.removed !== true && source.archived !== true;
}
/** @param {Value} source */
function key(source) { return JSON.stringify([source.hostId ?? 'local', source.id]); }
/** @param {Value} source @param {Group} group */
function member(source, group) {
  return (source.hostId ?? 'local') === group.hostId && (source.project?.key || source.workspace || '/') === group.projectKey;
}
/** @param {Value|undefined} source @param {Group} group @param {SessionRow} row */
function rowMember(source, group, row) { return !!source && row.nativeId !== null && source.id === row.nativeId && source.relayId === row.id && member(source, group); }

/** Shared, foreground interest owner. Poll never waits for native discovery or history.
 * @param {unknown} value @returns {Group[]} */
function parseGroups(value) {
  if (!Array.isArray(value) || value.length > 16) throw new BridgeError('invalid-activity-interest', 'At most sixteen project descriptors are allowed.');
  const ids = new Set();
  let rowCount = 0;
  const groups = value.map(group => {
    if (!group || !validString(group.id, 8192) || !validString(group.projectKey, 4096) || !validString(group.hostId, 256) || ids.has(group.id)) throw new BridgeError('invalid-activity-interest', 'Project activity needs unique UI IDs and explicit project/host identities.');
    ids.add(group.id);
    /** @type {SessionRow[]|undefined} */ let sessions;
    if (group.sessions !== undefined) {
      if (!Array.isArray(group.sessions) || (rowCount += group.sessions.length) > MAX_SESSION_ROWS) throw new BridgeError('invalid-activity-interest', 'At most sixty-four visible session rows are allowed per poll.');
      const rowIds = new Set();
      sessions = group.sessions.map((/** @type {Value} */ row) => {
        if (!row || !validString(row.id, 8192) || rowIds.has(row.id)) throw new BridgeError('invalid-activity-interest', 'Visible session rows need unique phone IDs.');
        rowIds.add(row.id);
        // 缺失或非法 nativeId 只能得到此 phone ID 的 unknown，不能退回任意已绑定会话。
        return { id: row.id, nativeId: validString(row.nativeId, 512) ? row.nativeId : null };
      });
    }
    return { id: group.id, projectKey: group.projectKey, hostId: group.hostId, ...(sessions === undefined ? {} : { sessions }) };
  });
  return groups;
}

export class NativeProjectActivityService {
  /** @param {{sources:()=>Value[],inventoryAvailable:()=>boolean,observerFactory?:(options:Value)=>Value,ipcFactory?:(hostId:string)=>Value,now?:()=>number,leaseMs?:number,maxSources?:number,concurrency?:number,epoch?:string}} options */
  constructor(options) {
    if (!options || typeof options.sources !== 'function' || typeof options.inventoryAvailable !== 'function') throw new BridgeError('invalid-activity-service', 'A native source inventory is required.');
    this.sources = options.sources; this.inventoryAvailable = options.inventoryAvailable;
    this.now = options.now ?? Date.now; this.leaseMs = options.leaseMs ?? 30000;
    this.maxSources = options.maxSources ?? 128; this.concurrency = options.concurrency ?? 4;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1 || this.leaseMs > 30000 || !Number.isSafeInteger(this.maxSources) || this.maxSources < 1 || this.maxSources > 128 || !Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4) throw new BridgeError('invalid-activity-limit', 'Activity leases, observer count and concurrency must fit their bounds.');
    this.observerFactory = options.observerFactory ?? (options => new CodexActivityObserver(/** @type {any} */ (options)));
    this.ipcFactory = options.ipcFactory ?? (hostId => new CodexIpcAdapter({ hostId }));
    this.epoch = options.epoch ?? randomUUID(); this.sequence = 0; this.closed = false;
    this.interests = /** @type {Map<string,Interest>} */ (new Map());
    this.entries = /** @type {Map<string,Entry>} */ (new Map());
    this.ipcs = /** @type {Map<string,Value>} */ (new Map());
    this.inFlight = 0; this.scheduled = false;
    this.timer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
  }
  /** Reserve ordering synchronously, including releases, before any outside asynchronous scope check.
   * @param {{clientId:string,requestSeq:number,groups:Group[]}} request */
  poll(request) {
    if (this.closed) throw new BridgeError('activity-service-closed', 'Project activity is unavailable.', 503);
    if (!request || !validString(request.clientId, 256) || !Number.isSafeInteger(request.requestSeq) || request.requestSeq < 0) throw new BridgeError('invalid-activity-interest', 'A stable client identity and monotonic request sequence are required.');
    const groups = parseGroups(request.groups), now = this.now();
    if (Buffer.byteLength(JSON.stringify({ clientId: request.clientId, requestSeq: request.requestSeq, groups }), 'utf8') > MAX_REQUEST_BYTES) throw new BridgeError('invalid-activity-interest', 'Project activity descriptors exceeded their size budget.');
    this.expire(now);
    const fingerprint = JSON.stringify(groups), previous = this.interests.get(request.clientId);
    if (previous && request.requestSeq < previous.requestSeq) throw new BridgeError('stale-activity-interest', 'A newer foreground interest has already been received.', 409);
    if (previous && request.requestSeq === previous.requestSeq) {
      if (fingerprint !== previous.fingerprint) throw new BridgeError('activity-interest-conflict', 'An activity request sequence cannot be reused for another interest.', 409);
      // 同序号重试不延长旧 lease，更不能使已释放或过期的兴趣重新出现。
    } else {
      if (!previous && this.interests.size >= MAX_CLIENTS) throw new BridgeError('activity-interest-limit', 'The bounded activity client registry is full.', 503);
      this.interests.set(request.clientId, { requestSeq: request.requestSeq, fingerprint, groups, expiresAt: groups.length ? now + this.leaseMs : now,
        retainUntil: now + (groups.length ? this.leaseMs : 0) + TOMBSTONE_MS });
    }
    const inventory = this.inventory();
    this.reconcile(inventory, now);
    for (const entry of this.entries.values()) {
      // Warm poll 只读小 replica；只有未确认的源进入快照恢复队列。
      try { if (!entry.starting && !entry.observer.status().known) entry.queued = true; } catch { /* 不支持的状态读取保留 unknown。 */ }
    }
    const summaries = groups.map(group => this.summary(group, inventory, now));
    this.schedule(); this.armTimer(now);
    return { ok: true, version: 1, epoch: this.epoch, sequence: ++this.sequence, observedAt: now, groups: summaries };
  }
  inventory() {
    let available = false;
    /** @type {Value[]} */ let sources = [];
    try {
      available = this.inventoryAvailable() === true;
      const current = this.sources();
      if (!Array.isArray(current)) available = false;
      else {
        const distinct = new Map();
        for (const source of current) if (source && nativeSource(source)) distinct.set(key(source), source);
        sources = [...distinct.values()];
      }
    } catch { available = false; }
    return { available, sources };
  }
  /** @param {number} now */
  expire(now) {
    for (const [client, interest] of this.interests) {
      if (interest.expiresAt <= now) interest.groups = [];
      if (interest.retainUntil <= now) this.interests.delete(client);
    }
  }
  /** @param {{available:boolean,sources:Value[]}} inventory @param {number} now */
  reconcile(inventory, now) {
    const groups = [...this.interests.values()].filter(interest => interest.expiresAt > now).flatMap(interest => interest.groups);
    const desired = new Map();
    if (inventory.available) {
      const indexed = new Map(inventory.sources.map(source => [key(source), source]));
      // 可见行先分配全机共享预算；native/relay/project/host 四项都命中才能获得优先级。
      for (const group of groups) for (const row of group.sessions ?? []) {
        const source = row.nativeId === null ? undefined : indexed.get(key({ id: row.nativeId, hostId: group.hostId }));
        if (rowMember(source, group, row) && desired.size < this.maxSources) desired.set(key(/** @type {Value} */ (source)), source);
      }
      for (const source of inventory.sources) {
        if (groups.some(group => member(source, group)) && desired.size < this.maxSources) desired.set(key(source), source);
      }
    }
    for (const [identity, entry] of this.entries) if (!desired.has(identity)) {
      entry.closed = true; entry.observer.close(); this.entries.delete(identity);
    }
    for (const [identity, source] of desired) if (!this.entries.has(identity)) {
      const hostId = source.hostId ?? 'local';
      let ipc = this.ipcs.get(hostId);
      if (!ipc) { ipc = this.ipcFactory(hostId); this.ipcs.set(hostId, ipc); }
      try {
        const observer = this.observerFactory({ id: source.id, hostId, ipc, now: this.now, requestRefresh: () => this.queueRefresh(identity) });
        this.entries.set(identity, { source: { id: source.id, hostId }, observer, starting: false, queued: true, closed: false });
      } catch { /* 不支持的源保留在 total/unknown，不伪装成 idle。 */ }
    }
    // 同时按可见优先顺序启动；已有冷任务不能把新滚入屏幕的行一直排在队尾。
    const ordered = /** @type {Map<string,Entry>} */ (new Map());
    for (const identity of desired.keys()) { const entry = this.entries.get(identity); if (entry) ordered.set(identity, entry); }
    this.entries = ordered;
    const hosts = new Set([...this.entries.values()].map(entry => entry.source.hostId ?? 'local'));
    for (const [hostId, ipc] of this.ipcs) if (!hosts.has(hostId)) { ipc.dispose?.(); this.ipcs.delete(hostId); }
  }
  /** @param {Group} group @param {{available:boolean,sources:Value[]}} inventory @param {number} _now */
  summary(group, inventory, _now) {
    const members = inventory.sources.filter(source => member(source, group));
    const byNativeId = new Map(members.map(source => [source.id, source]));
    const states = /** @type {Map<string,Value|null>} */ (new Map());
    let active = 0, waiting = 0, unknown = 0, refreshing = false;
    for (const source of members) {
      const entry = this.entries.get(key(source));
      let status;
      try { status = inventory.available && entry && !entry.closed ? entry.observer.status() : null; } catch { status = null; }
      states.set(source.id, status);
      if (!status?.known) { unknown++; refreshing ||= status?.status === 'refreshing' || !!entry?.queued; }
      else { if (status.active === true) active++; if (status.waiting === true) waiting++; }
    }
    return { id: group.id, total: members.length, active, waiting, unknown,
      status: !inventory.available ? 'unavailable' : unknown ? refreshing ? 'refreshing' : 'unavailable' : 'ready',
      ...(group.sessions === undefined ? {} : { sessions: group.sessions.map(row => {
        const source = row.nativeId === null ? undefined : byNativeId.get(row.nativeId);
        const state = inventory.available && rowMember(source, group, row) ? states.get(/** @type {string} */ (row.nativeId)) : null;
        const known = state?.known === true;
        return { id: row.id, known, active: known && state?.active === true, waiting: known && state?.waiting === true };
      }) }) };
  }
  schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  /** Native gaps share the same concurrency bound as initial reads.
   * @param {string} identity */
  queueRefresh(identity) {
    const entry = this.entries.get(identity);
    if (this.closed || !entry || entry.closed || entry.starting) return;
    entry.queued = true; this.schedule();
  }
  pump() {
    if (this.closed) return;
    const now = this.now();
    this.expire(now);
    // 后台 completion 只检查当前兴趣，不能从旧任务捕获的 sources 重建已释放兴趣。
    this.reconcile(this.inventory(), now);
    for (const entry of this.entries.values()) {
      if (this.inFlight >= this.concurrency) break;
      if (entry.closed || entry.starting || !entry.queued) continue;
      let status;
      try { status = entry.observer.status(); } catch { continue; }
      if (status.known) { entry.queued = false; continue; }
      entry.starting = true; entry.queued = false; this.inFlight++;
      Promise.resolve().then(() => entry.closed ? undefined : entry.observer.refresh()).catch(() => {}).finally(() => {
        entry.starting = false; this.inFlight--;
        if (!this.closed) this.schedule();
      });
    }
    this.armTimer(now);
  }
  /** @param {number} now */
  armTimer(now) {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.closed) return;
    const deadlines = [...this.interests.values()].map(interest => interest.groups.length ? interest.expiresAt : interest.retainUntil);
    if (!deadlines.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const time = this.now(); this.expire(time); this.reconcile(this.inventory(), time); this.armTimer(time);
    }, Math.max(1, Math.min(2147483647, Math.min(...deadlines) - now)));
    this.timer.unref();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.interests.clear();
    for (const entry of this.entries.values()) { entry.closed = true; entry.observer.close(); }
    this.entries.clear();
    for (const ipc of this.ipcs.values()) ipc.dispose?.();
    this.ipcs.clear();
  }
}
