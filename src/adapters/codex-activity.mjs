import { CodexIpcAdapter } from './codex-ipc.mjs';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string, any>} Value */
/** @typedef {{known:boolean,active:boolean,waiting:boolean,status:'ready'|'refreshing'|'unavailable',observedAt:number,generation:string|null,revision:number|null}} Activity */
const LIMIT = Object.freeze({ turns: 2048, items: 16384, ids: 4096, id: 512, patches: 50000, replyBytes: 128 * 1024 });
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const ACTIVE_TURNS = new Set(['inProgress', 'running', 'active']);
const FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);

/** Read-only, bounded local projection; no model, navigation or conversation renderer.
 * @param {unknown} value @returns {value is Value} */
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value @returns {string|null} */
function id(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > LIMIT.id) throw Error('Unsupported native identity.');
  return value;
}
/** @param {unknown} value */
function runtime(value) {
  if (!record(value) || !Array.isArray(value.activeFlags) || value.activeFlags.length > 16) throw Error('Missing runtime status.');
  return { type: id(value.type), activeFlags: value.activeFlags.map(id) };
}
/** @param {unknown} value */
function requests(value) {
  if (!Array.isArray(value) || value.length > LIMIT.ids || value.some(request => !record(request))) throw Error('Missing native requests.');
  return value.map(() => true);
}
/** @param {unknown} value */
function questions(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > LIMIT.ids) throw Error('Unsupported native questions.');
  // 原 question title 只参与合法性判断；问题正文和选项从不进入 replica。
  return value.map(question => typeof question?.title === 'string');
}
/** Only inspect bounded native reply wrappers; never keep input or answer text.
 * @param {unknown} value @returns {string[]} */
function replyIds(value) {
  const open = '<send_user_message_question_reply>', close = '</send_user_message_question_reply>';
  let text = '';
  const parts = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  for (const part of parts) {
    const next = typeof part === 'string' ? part : record(part) && ['text', 'input_text', 'output_text', 'inputText', 'outputText', 'summary_text'].includes(part.type) && typeof part.text === 'string' ? part.text : '';
    if (!next) continue;
    if (text.length + next.length > LIMIT.replyBytes) {
      if ((text || next).trimStart().startsWith(open)) throw Error('Native reply exceeded reduction limit.');
      return [];
    }
    text += (text ? '\n' : '') + next;
  }
  text = text.trim();
  if (!text.startsWith(open) || !text.endsWith(close)) return [];
  try {
    const parsed = JSON.parse(text.slice(open.length, -close.length));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    if (!entries.length || entries.length > LIMIT.ids || !entries.every(reply => record(reply) && typeof reply.questionItemId === 'string' && typeof reply.question === 'string' && typeof reply.answer === 'string')) return [];
    return entries.map(reply => /** @type {string} */ (id(reply.questionItemId)));
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}
/** @param {unknown} value @returns {Value|null} */
function item(value) {
  if (!record(value)) return null;
  if (value.type === 'agentMessage') return { type: value.type, id: id(value.id), questions: questions(value.questions) };
  if (value.type === 'userMessage') return { type: value.type, replies: replyIds(value.content) };
  if (value.type === 'steeringUserMessage') return { type: value.type, status: id(value.status), replies: value.status === 'accepted' ? replyIds(value.input) : [] };
  return null;
}
/** @param {unknown} value */
function items(value) {
  if (!Array.isArray(value) || value.length > LIMIT.items) throw Error('Unsupported native items.');
  return value.map(item);
}
/** @param {unknown} value @returns {Value} */
function turn(value) {
  if (!record(value)) throw Error('Unsupported native turn.');
  return { turnId: id(value.turnId), id: id(value.id), status: id(value.status), items: value.items == null ? [] : items(value.items) };
}
/** @param {unknown} value */
function turns(value) {
  if (!Array.isArray(value) || value.length > LIMIT.turns) throw Error('Unsupported turn history.');
  return value.map(turn);
}
/** @param {unknown} value */
function islands(value) {
  if (!Array.isArray(value) || value.length > LIMIT.turns) throw Error('Unsupported native ordering.');
  let count = 0;
  return value.map(island => {
    if (!record(island) || !Array.isArray(island.entries) || (count += island.entries.length) > LIMIT.turns) throw Error('Unsupported native ordering.');
    return { entries: island.entries.map((/** @type {Value} */ entry) => {
      const key = id(entry?.value); if (!key || FORBIDDEN.has(key)) throw Error('Missing native turn key.');
      return { value: key };
    }) };
  });
}
/** @param {unknown} value @returns {Value} */
function snapshot(value) {
  if (!record(value)) throw Error('Missing native state.');
  const output = /** @type {Value} */ ({ threadRuntimeStatus: runtime(value.threadRuntimeStatus), requests: requests(value.requests) });
  const history = value.turnHistory?.history;
  if (record(history?.entitiesByKey) && Array.isArray(history.islands)) {
    const keys = Object.keys(history.entitiesByKey);
    if (keys.length > LIMIT.turns) throw Error('Native history exceeded reduction limit.');
    const entities = /** @type {Value} */ (Object.create(null));
    for (const key of keys) {
      if (key.length > LIMIT.id || FORBIDDEN.has(key)) throw Error('Unsupported native turn key.');
      entities[key] = turn(history.entitiesByKey[key]);
    }
    output.turnHistory = { history: { entitiesByKey: entities, islands: islands(history.islands) } };
  }
  if (Array.isArray(value.turns)) output.turns = turns(value.turns);
  if (!output.turnHistory && !output.turns) throw Error('Missing native turn history.');
  budget(output);
  return output;
}
/** @param {Value} state @returns {Value[]} */
function loadedTurns(state) {
  const history = state.turnHistory?.history;
  const ordered = history ? history.islands.flatMap((/** @type {Value} */ island) => island.entries.map((/** @type {Value} */ entry) => {
    const value = history.entitiesByKey[entry.value];
    if (!value) throw Error('Missing ordered native turn.');
    return value;
  })) : [];
  return ordered.length ? ordered : state.turns ?? [];
}
/** @param {Value} state */
function budget(state) {
  const all = [...Object.values(state.turnHistory?.history.entitiesByKey ?? {}), ...state.turns ?? []];
  if (all.length > LIMIT.turns || state.requests.length > LIMIT.ids || !state.threadRuntimeStatus || !Array.isArray(state.threadRuntimeStatus.activeFlags) || state.threadRuntimeStatus.activeFlags.length > 16) throw Error('Native activity exceeded reduction limit.');
  let count = 0, identities = 0;
  for (const t of all) for (const i of t.items) {
    if (++count > LIMIT.items || (identities += i?.questions?.length ?? i?.replies?.length ?? 0) > LIMIT.ids) throw Error('Native activity exceeded reduction limit.');
  }
  loadedTurns(state);
}
/** @param {Value} state */
function projection(state) {
  const native = state.threadRuntimeStatus;
  if (!['active', 'idle'].includes(native.type) || !native.activeFlags.every((/** @type {unknown} */ flag) => FLAGS.has(/** @type {string} */ (flag)))) return null;
  const ordered = loadedTurns(state);
  const current = ordered.findLast(t => ACTIVE_TURNS.has(t.status));
  const selectedId = current?.turnId ?? current?.id ?? ordered.at(-1)?.turnId ?? ordered.at(-1)?.id ?? null;
  const answered = new Set(ordered.flatMap(t => t.items.flatMap((/** @type {Value|null} */ i) => i?.replies ?? [])));
  const unanswered = typeof selectedId === 'string' && !!selectedId && ordered.filter(t => (t.turnId ?? t.id) === selectedId).some(t => t.items.some((/** @type {Value|null} */ i) => i?.type === 'agentMessage' && typeof i.id === 'string' && i.questions.some((/** @type {boolean} */ valid, /** @type {number} */ index) => valid && !answered.has(JSON.stringify(['request_user_input_async', i.id, index])))));
  return { active: native.type === 'active', waiting: state.requests.length > 0 || native.activeFlags.length > 0 || !!unanswered };
}
/** Apply only reduced values to a small independent replica, atomically.
 * @param {Value} base @param {unknown} values @returns {Value} */
function patches(base, values) {
  if (!Array.isArray(values) || values.length > LIMIT.patches) throw Error('Unsupported native patches.');
  let output = structuredClone(base);
  for (const patch of values) {
    if (!record(patch) || !['add', 'replace', 'remove'].includes(patch.op) || !Array.isArray(patch.path) || patch.path.length > 256 || patch.path.some(key => (typeof key !== 'string' && !(Number.isSafeInteger(key) && key >= 0)) || FORBIDDEN.has(key))) throw Error('Unsupported native patch.');
    const path = patch.path;
    if (!path.length) { if (patch.op === 'remove') throw Error('Missing native state.'); output = snapshot(patch.value); continue; }
    const reduced = reducePatch(output, patch);
    if (!reduced) continue;
    apply(output, reduced.path, reduced.op ?? patch.op, reduced.value);
  }
  budget(output);
  return output;
}
/** @param {Value} state @param {Value} patch @returns {{path:(string|number)[],value?:any,op?:string}|null} */
function reducePatch(state, patch) {
  const p = patch.path, removing = patch.op === 'remove';
  if (p[0] === 'threadRuntimeStatus') {
    if (p.length === 1) return { path: p, value: removing ? undefined : runtime(patch.value) };
    if (p[1] === 'type' && p.length === 2) return { path: p, value: id(patch.value) };
    if (p[1] === 'activeFlags' && p.length <= 3) return { path: p, value: p.length === 2 ? runtime({ type: 'active', activeFlags: patch.value }).activeFlags : id(patch.value) };
    throw Error('Unsupported runtime patch.');
  }
  if (p[0] === 'requests') {
    if (p.length === 1) return { path: p, value: removing ? undefined : requests(patch.value) };
    if (p.length === 2) {
      if (!removing && !record(patch.value)) throw Error('Unsupported native request membership.');
      return { path: p, value: true };
    }
    return null;
  }
  let offset;
  if (p[0] === 'turns') {
    if (p.length === 1) return { path: p, value: removing ? undefined : turns(patch.value) };
    offset = 2;
  } else if (p[0] === 'turnHistory') {
    if (p[1] !== 'history') throw Error('Unsupported history patch.');
    if (p[2] === 'islands') {
      if (p.length === 3) return { path: p, value: removing ? undefined : islands(patch.value) };
      // 复杂排序改变不能仅按旧数组位置推断最新轮；重新读取原 owner 快照。
      throw Error('Native ordering requires fresh snapshot.');
    }
    if (p[2] !== 'entitiesByKey' || p.length < 4) throw Error('Native history requires fresh snapshot.');
    offset = 4;
  } else return null;
  if (p.length === offset) return { path: p, value: removing ? undefined : turn(patch.value) };
  const field = p[offset];
  if (['turnId', 'id', 'status'].includes(field) && p.length === offset + 1) return { path: p, value: id(patch.value) };
  if (field !== 'items') return null;
  if (p.length === offset + 1) return { path: p, value: removing ? undefined : items(patch.value) };
  if (p.length === offset + 2) return { path: p, value: removing ? undefined : item(patch.value) };
  const current = get(state, p.slice(0, offset + 2)), child = p[offset + 2];
  if (child === 'type') throw Error('Native item type requires fresh snapshot.');
  if (!current) return null;
  if (current.type === 'agentMessage') {
    if (child === 'id' && p.length === offset + 3) return { path: p, value: id(patch.value) };
    if (child !== 'questions') return null;
    if (p.length === offset + 3) return { path: p, value: removing ? [] : questions(patch.value), op: 'replace' };
    if (p.length === offset + 4) return { path: p, value: typeof patch.value?.title === 'string' };
    if (p.length === offset + 5 && p[offset + 4] === 'title') return { path: p.slice(0, -1), value: !removing && typeof patch.value === 'string', op: 'replace' };
    return null;
  }
  if (current.type === 'steeringUserMessage' && child === 'status') throw Error('Accepted steering evidence requires fresh snapshot.');
  if (child === 'content' && current.type === 'userMessage' || child === 'input' && current.type === 'steeringUserMessage' && current.status === 'accepted') {
    if (p.length !== offset + 3) throw Error('Native reply delta requires fresh snapshot.');
    return { path: [...p.slice(0, -1), 'replies'], value: removing ? [] : replyIds(patch.value), op: 'replace' };
  }
  return null;
}
/** @param {Value} state @param {(string|number)[]} path @returns {any} */
function get(state, path) {
  let value = state;
  for (const key of path) { if (!value || !Object.hasOwn(value, key)) throw Error('Missing native patch base.'); value = value[key]; }
  return value;
}
/** @param {Value} state @param {(string|number)[]} path @param {string} op @param {any} value */
function apply(state, path, op, value) {
  const parent = get(state, path.slice(0, -1)), key = path.at(-1);
  if (Array.isArray(parent)) {
    if (key === 'length' && op === 'replace' && Number.isSafeInteger(value) && value >= 0 && value <= parent.length) { parent.length = value; return; }
    if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0 || key > parent.length || op !== 'add' && key === parent.length) throw Error('Invalid native array patch.');
    if (op === 'add') parent.splice(key, 0, value); else if (op === 'remove') parent.splice(key, 1); else parent[key] = value;
  } else {
    if (!record(parent) || typeof key !== 'string' || op !== 'add' && !Object.hasOwn(parent, key)) throw Error('Invalid native object patch.');
    if (op === 'remove') delete parent[key]; else parent[key] = value;
  }
}

export class CodexActivityObserver {
  /** @param {{id:string,hostId?:string,ipc?:Value,now?:()=>number,onChange?:(status:Activity)=>void,requestRefresh?:()=>void}} options */
  constructor(options) {
    if (!options || typeof options.id !== 'string' || !options.id.trim()) throw new BridgeError('invalid-session', 'A native session identity is required.');
    this.id = options.id; this.hostId = options.hostId ?? 'local';
    this.ownsIpc = !options.ipc; this.ipc = options.ipc ?? new CodexIpcAdapter({ hostId: this.hostId });
    this.now = options.now ?? Date.now; this.onChange = options.onChange ?? (() => {});
    this.requestRefresh = options.requestRefresh ?? (() => { void this.refresh(); });
    this.connection = /** @type {Value|null} */ (null); this.followerClientId = /** @type {string|null} */ (null);
    this.replica = /** @type {Value|null} */ (null); this.value = /** @type {Activity} */ ({ known: false, active: false, waiting: false, status: 'refreshing', observedAt: this.now(), generation: null, revision: null });
    this.closed = false; this.lifecycle = 0; this.release = /** @type {(()=>void)|null} */ (null);
    this.starting = /** @type {Promise<void>|null} */ (null); this.refreshing = /** @type {Promise<void>|null} */ (null);
  }
  start() {
    if (this.closed || this.release) return Promise.resolve();
    if (this.starting) return this.starting;
    const lifecycle = this.lifecycle;
    const operation = Promise.resolve().then(() => {
      if (this.closed || this.lifecycle !== lifecycle) return null;
      return this.ipc.subscribe(this.id, (/** @type {Value} */ frame) => {
        if (!this.closed && this.lifecycle === lifecycle) this.receive(frame);
      });
    }).then((release) => { if (!release) return; if (this.closed || this.lifecycle !== lifecycle) release(); else this.release = release; })
      .catch(() => { if (!this.closed && this.lifecycle === lifecycle) this.invalidate('unavailable'); })
      .finally(() => { if (this.starting === operation) this.starting = null; });
    this.starting = operation; return operation;
  }
  refresh() {
    if (this.closed) return Promise.resolve();
    if (!this.release) return this.start();
    if (this.refreshing) return this.refreshing;
    const lifecycle = this.lifecycle;
    const operation = Promise.resolve().then(async () => {
      if (this.closed || this.lifecycle !== lifecycle) return;
      await this.ipc.connect?.();
      if (!this.closed && this.lifecycle === lifecycle) return this.ipc.refreshSnapshot(this.id);
    }).catch(() => {
      if (!this.closed && this.lifecycle === lifecycle) this.invalidate('unavailable');
    }).finally(() => { if (this.refreshing === operation) this.refreshing = null; });
    this.refreshing = operation; return operation;
  }
  /** @param {Value} frame */
  receive(frame) {
    if (frame.type === 'bridge/status') {
      if (['disconnected', 'owner-disconnected', 'owner-unavailable', 'subscription-error'].includes(frame.status)) this.invalidate('unavailable');
      return;
    }
    if (frame.type !== 'broadcast' || frame.method !== 'thread-stream-state-changed') return;
    try {
      const owner = typeof frame.sourceClientId === 'string' && frame.sourceClientId ? `${this.hostId}:${frame.sourceClientId}` : null;
      if (!this.liveConnection() || frame.version !== 11 || frame.params?.hostId !== this.hostId || frame.params?.conversationId !== this.id || !owner || this.ipc.generation(this.id) !== owner) throw Error('Unconfirmed native owner.');
      const change = frame.params?.change;
      if (!record(change) || !Number.isSafeInteger(change.revision) || change.revision < 0) throw Error('Unsupported native revision.');
      if (change.type === 'snapshot') {
        if (this.value.generation === owner && this.value.revision !== null && change.revision < this.value.revision) return;
        this.replica = snapshot(change.conversationState);
      } else if (change.type === 'patches') {
        if (this.value.generation === owner && this.value.revision !== null && change.revision <= this.value.revision) return;
        if (this.value.generation !== owner || !this.replica || change.baseRevision !== this.value.revision) throw Error('Missing native patch baseline.');
        if (change.revision <= change.baseRevision) throw Error('Nonmonotonic native patch.');
        this.replica = patches(this.replica, change.patches);
      } else throw Error('Unsupported native state.');
      const facts = projection(this.replica);
      this.connection = this.ipc.socket; this.followerClientId = this.ipc.clientId;
      this.publish(/** @type {Activity} */ ({ known: facts !== null, active: facts?.active ?? false, waiting: facts?.waiting ?? false,
        status: facts ? 'ready' : 'unavailable', observedAt: this.now(), generation: owner, revision: change.revision }));
    } catch {
      // 不完整 patch 或 owner 换代只能读取新快照；原输入和原 runner 不能被重建或重放。
      this.invalidate('refreshing');
      // 共享服务安排受限刷新；初次订阅或已有刷新失败等待下一次 poll，不能形成快照读取循环。
      if (this.release && !this.refreshing) this.requestRefresh();
    }
  }
  /** @param {'refreshing'|'unavailable'} status */
  invalidate(status) {
    this.replica = null; this.connection = null; this.followerClientId = null;
    this.publish({ known: false, active: false, waiting: false, status, observedAt: this.now(), generation: null, revision: null });
  }
  /** @param {Activity} value */
  publish(value) { this.value = value; try { this.onChange({ ...value }); } catch { /* 已关闭消费者不影响其他只读观察者。 */ } }
  liveConnection() { return this.ipc.socket?.destroyed === false && typeof this.ipc.clientId === 'string' && !!this.ipc.clientId && this.ipc.clientId !== 'initializing-client'; }
  status() {
    if (this.value.generation !== null && this.ipc.generation(this.id) !== this.value.generation) {
      // discovery 已换 owner 时旧 following 仍可能指向旧 attachment；必须清理此观察者再读新快照。
      this.invalidate('refreshing'); this.lifecycle++; this.release?.(); this.release = null;
    }
    if (this.value.known && (!this.liveConnection() || this.connection !== this.ipc.socket || this.followerClientId !== this.ipc.clientId)) this.invalidate('unavailable');
    return { ...this.value };
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.lifecycle++; this.release?.(); this.release = null; this.replica = null; this.connection = null; this.followerClientId = null;
    this.value = /** @type {Activity} */ ({ known: false, active: false, waiting: false, status: 'unavailable', observedAt: this.now(), generation: null, revision: null });
    if (this.ownsIpc) this.ipc.dispose();
  }
}
