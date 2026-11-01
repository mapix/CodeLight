import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
const OLD_MS = 72 * 60 * 60 * 1000;
/** @param {unknown} value */
function timestamp(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0; }
/** @param {unknown} cursor @param {string} kind @param {string|null} [sessionId] @returns {Value|null} */
function decode(cursor, kind, sessionId = null) {
  if (cursor == null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new BridgeError('invalid-history-cursor', 'The recent-data cursor is invalid.');
  let value; try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new BridgeError('invalid-history-cursor', 'The recent-data cursor is invalid.'); }
  if (!value || value.v !== 1 || value.kind !== kind || value.sessionId !== sessionId || typeof value.id !== 'string' || !value.id || value.id.length > 1000) throw new BridgeError('invalid-history-cursor', 'The recent-data cursor does not match this read.');
  return /** @type {Value} */ (value);
}
/** @param {Value} value */
function encode(value) { return Buffer.from(JSON.stringify({ v: 1, ...value })).toString('base64url'); }
/** @param {unknown} value @param {number} fallback @param {number} cap */
function limit(value, fallback, cap) {
  const selected = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > cap) throw new BridgeError('invalid-page-limit', 'The recent-data page limit is invalid.');
  return selected;
}

/** @param {{source:Value,binding:Value,actor?:Value}} entry @param {number} now @param {boolean} [forceFull] */
export function recentDescriptor(entry, now, forceFull = false) {
  const { source, binding, actor } = entry, nativeUpdatedAt = timestamp(source.updatedAt);
  const basicOnly = !forceFull && nativeUpdatedAt < now - OLD_MS;
  let checkpoint = /** @type {Value} */ ({});
  try { checkpoint = actor?.transport?.peerSnapshot?.() ?? {}; }
  catch { if (forceFull) throw new BridgeError('source-unavailable', 'The selected observer checkpoint is unavailable.', 503); }
  const original = checkpoint.metadata ?? binding.metadata ?? {};
  const nativeSession = { title: source.title || source.id, updatedAt: nativeUpdatedAt, parentId: source.parentId ?? null, agentName: source.agentName ?? '',
    catalogueAvailable: original.nativeSession?.catalogueAvailable !== false,
    ...(source.project ? { projectKey: source.project.key, projectPath: source.project.path, projectLabel: source.project.label } : {}) };
  const metadata = basicOnly ? { path: source.workspace ?? '', host: original.host ?? 'CodeLight Mac', flavor: 'codex', machineId: binding.machineId,
    client: original.client ?? { id: 'noninvasive-bridge' }, bridge: original.bridge, nativeSession, summary: { text: nativeSession.title, updatedAt: nativeUpdatedAt },
    ...(actor && checkpoint.metadata ? { capabilities: original.capabilities } : {}) }
    : { ...original, path: source.workspace ?? original.path ?? '', nativeSession: { ...original.nativeSession, ...nativeSession, preview: source.preview ?? '' },
      summary: { ...original.summary, text: nativeSession.title, updatedAt: nativeUpdatedAt } };
  return { id: binding.happySessionId, nativeUpdatedAt, basicOnly, metadata,
    metadataVersion: checkpoint.metadataVersion ?? binding.metadataVersion ?? 0,
    agentState: basicOnly ? null : checkpoint.agentState ?? null, agentStateVersion: checkpoint.agentStateVersion ?? 0,
    seq: checkpoint.seq ?? 0, createdAt: timestamp(source.createdAt), updatedAt: nativeUpdatedAt,
    // 在线描述的是已有观察链路；原生 running/idle 仍由独立 owner 状态投影决定。
    active: actor?.status?.().sourceStatus === 'connected', activeAt: checkpoint.observedAt ?? 0,
    ...(forceFull ? { sessionKey: binding.sessionKey } : {}) };
}

/** Directory reads are index-only and never activate sources.
 * @param {{source:Value,binding:Value,actor?:Value}[]} entries @param {{cursor?:unknown,limit?:unknown,now?:number}} [options] */
export function recentCatalogPage(entries, options = {}) {
  const now = options.now ?? Date.now(), cursor = decode(options.cursor, 'catalog'), count = limit(options.limit, cursor ? 1000 : 200, 2000);
  const rows = entries.filter(entry => entry.source.app === 'codex' && typeof entry.binding.happySessionId === 'string' && entry.binding.metadata?.nativeSession?.catalogueAvailable !== false)
    .map(entry => ({ entry, time: timestamp(entry.source.updatedAt), id: entry.binding.happySessionId }));
  rows.sort((a, b) => b.time - a.time || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
  if (cursor && (typeof cursor.time !== 'number' || !Number.isFinite(cursor.time))) throw new BridgeError('invalid-history-cursor', 'The catalog cursor is invalid.');
  const eligible = cursor ? rows.filter(row => row.time < cursor.time || row.time === cursor.time && row.id < cursor.id) : rows;
  const selected = eligible.slice(0, count), last = selected.at(-1), hasMore = eligible.length > selected.length;
  return { version: 1, sessions: selected.map(row => recentDescriptor(row.entry, now)), hasMore,
    nextCursor: hasMore && last ? encode({ kind: 'catalog', sessionId: null, id: last.id, time: last.time }) : null, scannedAt: now };
}

/** Public rows are complete original-row values, not the last N protocol fragments.
 * @param {string} sessionId @param {Value[]} rows @param {{cursor?:unknown,limit?:unknown,historyComplete?:boolean}} [options] */
export function recentRowsPage(sessionId, rows, options = {}) {
  const cursor = decode(options.cursor, 'rows', sessionId), count = limit(options.limit, 50, 100);
  const visible = rows.filter(row => typeof row.id === 'string' && row.id && typeof row.turnId === 'string' && ['user', 'assistant', 'reasoning', 'tool'].includes(row.role));
  const boundary = cursor && cursor.empty !== true ? visible.findIndex(row => row.id === cursor.id) : visible.length;
  if (boundary < 0) throw new BridgeError('stale-history-cursor', 'The earlier native row is no longer present in the current owner view.', 409);
  const start = Math.max(0, boundary - count), selected = visible.slice(start, boundary);
  const hasMore = start > 0 || options.historyComplete === false;
  return { rows: structuredClone(selected), hasMore,
    nextCursor: hasMore ? encode({ kind: 'rows', sessionId, id: selected[0]?.id ?? '@native-start', ...(selected[0] ? {} : { empty: true }) }) : null };
}

/** Coalesces selected source preparation/fresh reads; no directory history walks.
 * @param {{sources:()=>{source:Value,binding:Value,actor?:Value}[],resolveSource:(sessionId:string)=>Promise<{source:Value,binding:Value,actor:Value}>,available?:()=>boolean,now?:()=>number}} options */
export class CodeLightRecentService {
  /** @type {Map<string,Promise<Value>>} */ flights = new Map();
  /** @param {{sources:()=>{source:Value,binding:Value,actor?:Value}[],resolveSource:(sessionId:string)=>Promise<{source:Value,binding:Value,actor:Value}>,available?:()=>boolean,now?:()=>number}} options */
  constructor(options) { this.options = options; this.now = options.now ?? Date.now; }
  /** @param {Value} [params] */
  catalog(params = {}) { this.assertAvailable(); return recentCatalogPage(this.options.sources(), { ...params, now: this.now() }); }
  assertAvailable() { if (this.options.available?.() === false) throw new BridgeError('source-unavailable', 'The current native directory is unavailable.', 503); }
  /** @param {string} sessionId @param {Value} [params] @returns {Promise<Value>} */
  recent(sessionId, params = {}) {
    this.assertAvailable();
    const count = limit(params.limit, 50, 100), key = JSON.stringify([sessionId, count]);
    const pending = this.flights.get(key); if (pending) return pending.then(value => structuredClone(value));
    const flight = this.read(sessionId, { limit: count }, true).finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
    this.flights.set(key, flight); return flight.then(value => structuredClone(value));
  }
  /** @param {string} sessionId @param {Value} params */
  history(sessionId, params) { this.assertAvailable(); if (!params.cursor) throw new BridgeError('invalid-history-cursor', 'An earlier-history cursor is required.'); return this.read(sessionId, params, false); }
  /** @param {string} sessionId @param {Value} params @param {boolean} fresh */
  async read(sessionId, params, fresh) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new BridgeError('invalid-session', 'A selected session identity is required.');
    const entry = await this.options.resolveSource(sessionId); this.assertAvailable();
    if (entry.binding.happySessionId !== sessionId || typeof entry.actor.connector?.readRecent !== 'function') throw new BridgeError('source-unavailable', 'The selected native observer is unavailable.', 503);
    const snapshot = await entry.actor.connector.readRecent({ ...params, fresh }); this.assertAvailable();
    return { version: 1, session: recentDescriptor(entry, this.now(), true), ...snapshot, observedAt: this.now() };
  }
}
