/**
 * Happy encrypted session transport, adapted from slopus/happy at
 * ee5ccff79b046570dc7e62eeec90e7c8a9d7027e (apiSession, RpcHandlerManager,
 * happy-agent encryption and Happy Blobs derivation). No runner is imported.
 *
 * MIT License — Copyright (c) 2026 Happy Coder Contributors
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { EventEmitter } from 'node:events';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { io } from 'socket.io-client';
import nacl from 'tweetnacl';

/** @typedef {Record<string, any>} Value */
/** @typedef {'dataKey'|'legacy'} EncryptionVariant */
/** @typedef {{id:string,seq:number,localId:string|null,createdAt:number,updatedAt:number,content:{t:'encrypted',c:string}}} EncryptedMessage */
/** @typedef {EncryptedMessage & {record:unknown,publishedByThisTransport:boolean,decodeError?:string}} IncomingRecord */
/** @typedef {{id:string,seq:number,localId:string,createdAt:number,updatedAt:number}} MessageAck */
/** @typedef {(params:unknown,context:{sessionId:string,method:string})=>unknown|Promise<unknown>} RpcHandler */
/** @typedef {{serverOrigin:string,token:string,sessionId:string,encryptionKey:Uint8Array,variant?:EncryptionVariant,statePath:string,pollMs?:number,requestTimeoutMs?:number,maxJournalEntries?:number,initialMetadata?:unknown,metadataVersion?:number,initialAgentState?:unknown,agentStateVersion?:number}} TransportOptions */

const stateOwners = new Set();
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export class HappyTransportError extends Error {
  /** @param {string} code @param {string} message @param {boolean} [effectMayHaveOccurred] */
  constructor(code, message, effectMayHaveOccurred = false) {
    super(message); this.name = 'HappyTransportError'; this.code = code; this.effectMayHaveOccurred = effectMayHaveOccurred;
  }
}

/** @param {Uint8Array} key */
function checkKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new HappyTransportError('invalid-encryption-key', 'A 32-byte Happy encryption key is required.');
}
/** @param {unknown} value */
function jsonText(value) {
  let text;
  try { text = JSON.stringify(value); } catch { throw new HappyTransportError('invalid-json-record', 'The Happy record must be JSON serializable.'); }
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new HappyTransportError('invalid-json-record', 'The Happy record is missing or exceeds the bounded record limit.');
  return text;
}
/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(/** @type {Value} */ (value)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Happy JSON bundle, returned as the base64 string used by /v3/messages. @param {unknown} value @param {Uint8Array} key @param {EncryptionVariant} [variant] */
export function encryptRecord(value, key, variant = 'dataKey') {
  checkKey(key);
  const plain = Buffer.from(jsonText(value));
  if (variant === 'legacy') return Buffer.from(encryptBlob(plain, key)).toString('base64');
  if (variant !== 'dataKey') throw new HappyTransportError('invalid-encryption-variant', 'Unsupported Happy encryption variant.');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([0]), nonce, encrypted, cipher.getAuthTag()]).toString('base64');
}

/** Returns null for invalid/unreadable ciphertext. @param {string} encoded @param {Uint8Array} key @param {EncryptionVariant} [variant] @returns {unknown|null} */
export function decryptRecord(encoded, key, variant = 'dataKey') {
  checkKey(key);
  try {
    const bundle = Buffer.from(encoded, 'base64');
    let plain;
    if (variant === 'legacy') { plain = decryptBlob(bundle, key); if (!plain) return null; }
    else {
      if (variant !== 'dataKey' || bundle.length < 29 || bundle[0] !== 0) return null;
      const decipher = createDecipheriv('aes-256-gcm', key, bundle.subarray(1, 13));
      decipher.setAuthTag(bundle.subarray(bundle.length - 16));
      plain = Buffer.concat([decipher.update(bundle.subarray(13, bundle.length - 16)), decipher.final()]);
    }
    return JSON.parse(Buffer.from(plain).toString('utf8'));
  } catch { return null; }
}

/** @param {Uint8Array} master @param {string} usage @param {string[]} path */
function deriveHappyKey(master, usage, path) {
  checkKey(master);
  let hmac = createHmac('sha512', `${usage} Master Seed`).update(master).digest();
  let key = hmac.subarray(0, 32), chainCode = hmac.subarray(32);
  for (const index of path) {
    hmac = createHmac('sha512', chainCode).update(Buffer.concat([Buffer.from([0]), Buffer.from(index)])).digest();
    key = hmac.subarray(0, 32); chainCode = hmac.subarray(32);
  }
  return new Uint8Array(key);
}

/** Pure helper for an explicitly supplied NEW test/account secret; does not read credentials. @param {Uint8Array} accountSecret */
export function deriveContentKeyPair(accountSecret) {
  const seed = deriveHappyKey(accountSecret, 'Happy EnCoder', ['content']);
  const secretKey = createHash('sha512').update(seed).digest().subarray(0, 32);
  const pair = nacl.box.keyPair.fromSecretKey(new Uint8Array(secretKey));
  return { publicKey: pair.publicKey, secretKey: pair.secretKey };
}

/** Current Happy explicit-nonce box format, including the DEK version byte. @param {Uint8Array} dataKey @param {Uint8Array} recipientPublicKey */
export function sealDataKey(dataKey, recipientPublicKey) {
  checkKey(dataKey); checkKey(recipientPublicKey);
  const ephemeral = nacl.box.keyPair(), nonce = randomBytes(24);
  const cipher = nacl.box(dataKey, nonce, recipientPublicKey, ephemeral.secretKey);
  return new Uint8Array(Buffer.concat([Buffer.from([0]), Buffer.from(ephemeral.publicKey), nonce, Buffer.from(cipher)]));
}

/** @param {Uint8Array} bundle @param {Uint8Array} recipientSecretKey */
export function unsealDataKey(bundle, recipientSecretKey) {
  checkKey(recipientSecretKey);
  if (bundle.length !== 105 || bundle[0] !== 0) return null;
  try {
    const result = nacl.box.open(bundle.subarray(57), bundle.subarray(33, 57), bundle.subarray(1, 33), recipientSecretKey);
    return result?.length === 32 ? new Uint8Array(result) : null;
  } catch { return null; }
}

/** @param {Uint8Array} key @param {EncryptionVariant} [variant] */
export function deriveBlobKey(key, variant = 'dataKey') {
  if (!['dataKey', 'legacy'].includes(variant)) throw new HappyTransportError('invalid-encryption-variant', 'Unsupported Happy encryption variant.');
  return deriveHappyKey(key, 'Happy Blobs', [variant === 'dataKey' ? 'session' : 'master']);
}
/** @param {Uint8Array} data @param {Uint8Array} key */
export function encryptBlob(data, key) {
  checkKey(key);
  const nonce = randomBytes(24), cipher = nacl.secretbox(new Uint8Array(data), nonce, key);
  return new Uint8Array(Buffer.concat([nonce, Buffer.from(cipher)]));
}
/** @param {Uint8Array} bundle @param {Uint8Array} key */
export function decryptBlob(bundle, key) {
  checkKey(key);
  if (bundle.length < 40) return null;
  try { const plain = nacl.secretbox.open(bundle.subarray(24), bundle.subarray(0, 24), key); return plain ? new Uint8Array(plain) : null; } catch { return null; }
}

/** @param {unknown} value @param {string} field @returns {string} */
function requiredString(value, field) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\u0000-\u001f]/u.test(value)) throw new HappyTransportError('invalid-transport-options', `A bounded ${field} is required.`);
  return value;
}
/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function boundedInteger(value, fallback, min, max) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || /** @type {number} */ (number) < min || /** @type {number} */ (number) > max) throw new HappyTransportError('invalid-transport-options', 'A transport limit is outside its supported range.');
  return /** @type {number} */ (number);
}
/** @param {unknown} error */
function errorCode(error) { return error instanceof HappyTransportError ? error.code : 'transport-error'; }

export class HappySessionTransport extends EventEmitter {
  /** @type {Uint8Array} */ #key;
  /** @type {string} */ #token;
  /** @type {EncryptionVariant} */ #variant;
  /** @type {TransportOptions} */ #options;
  /** @type {Value} */ #state = {};
  /** @type {string|null} */ #expectedStateText = null;
  /** @type {import('socket.io-client').Socket|null} */ #socket = null;
  /** @type {Map<string,RpcHandler>} */ #rpcHandlers = new Map();
  /** @type {ReturnType<typeof setInterval>|null} */ #timer = null;
  /** @type {Set<AbortController>} */ #requests = new Set();
  #ioTail = Promise.resolve();
  /** @type {Promise<Value>|null} */ #receiveFlight = null;
  /** @type {Promise<Value>|null} */ #flushFlight = null;
  /** @type {Promise<Value>|null} */ #startFlight = null;
  /** @type {Promise<void>|null} */ #closeFlight = null;
  /** @type {Map<string,Promise<unknown>>} */ #fieldFlights = new Map();
  #closed = false;
  #started = false;
  /** @type {string|null} */ #lastErrorCode = null;

  /** @param {TransportOptions} options */
  constructor(options) {
    super({ captureRejections: true });
    const url = new URL(requiredString(options.serverOrigin, 'server origin'));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new HappyTransportError('invalid-transport-options', 'Use an explicit HTTP(S) server origin without credentials or paths.');
    this.serverOrigin = url.origin;
    this.sessionId = requiredString(options.sessionId, 'Happy session id');
    if (!/^[a-zA-Z0-9_-]{1,200}$/u.test(this.sessionId)) throw new HappyTransportError('invalid-transport-options', 'Invalid Happy session id.');
    this.#token = requiredString(options.token, 'Happy token');
    checkKey(options.encryptionKey); this.#key = new Uint8Array(options.encryptionKey);
    this.#variant = options.variant ?? 'dataKey';
    if (!['dataKey', 'legacy'].includes(this.#variant)) throw new HappyTransportError('invalid-encryption-variant', 'Unsupported Happy encryption variant.');
    if (!isAbsolute(options.statePath)) throw new HappyTransportError('invalid-transport-options', 'The owned transport checkpoint path must be absolute.');
    this.statePath = resolve(options.statePath);
    this.pollMs = boundedInteger(options.pollMs, 5000, 0, 300000);
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs, 10000, 250, 120000);
    this.maxJournalEntries = boundedInteger(options.maxJournalEntries, 50000, 1, 1000000);
    this.#options = options;
    this.on('error', error => this.#diagnostic(errorCode(error), 'observer'));
  }

  status() {
    return { started: this.#started, closed: this.#closed, connected: this.#socket?.connected === true,
      serverOrigin: this.serverOrigin, sessionId: this.sessionId, receiveCursor: this.#state?.receiveCursor ?? 0,
      pendingOutbox: this.#state?.outbox?.length ?? 0, pendingInbox: this.#state?.inbox?.length ?? 0,
      registeredRpcMethods: [...this.#rpcHandlers.keys()], lastErrorCode: this.#lastErrorCode };
  }

  /** Existing decrypted checkpoint fields, only for the authenticated Mac peer read surface. */
  peerSnapshot() {
    this.#requireReady();
    const metadata = this.#state.fields.metadata, agentState = this.#state.fields.agentState;
    return { metadata: metadata.value ? decryptRecord(metadata.value, this.#key, this.#variant) : null, metadataVersion: metadata.version,
      agentState: agentState.value ? decryptRecord(agentState.value, this.#key, this.#variant) : null, agentStateVersion: agentState.version,
      seq: this.#state.receiveCursor };
  }

  /** @param {{connectSocket?:boolean}} [options] */
  start(options = {}) {
    if (this.#startFlight) return this.#startFlight;
    this.#startFlight = this.#start(options.connectSocket !== false);
    return this.#startFlight;
  }

  /** @param {boolean} connectSocket @returns {Promise<Value>} */
  async #start(connectSocket) {
    if (this.#closed) throw new HappyTransportError('transport-closed', 'The transport is closed.');
    if (stateOwners.has(this.statePath)) throw new HappyTransportError('transport-in-use', 'The transport checkpoint already has an owner.');
    stateOwners.add(this.statePath);
    try { await this.#load(); } catch (error) { stateOwners.delete(this.statePath); throw error; }
    if (this.#closed) { stateOwners.delete(this.statePath); throw new HappyTransportError('transport-closed', 'The transport closed while starting.'); }
    this.#started = true;
    if (this.#state.inbox.length) this.emit('recoverable-inbox', { ids: this.#state.inbox.map((/** @type {EncryptedMessage} */ record) => record.id), count: this.#state.inbox.length });
    if (connectSocket) this.#connectSocket();
    if (this.pollMs) {
      this.#timer = setInterval(() => { this.catchUp().catch(error => this.#diagnostic(errorCode(error), 'receive')); this.flush().catch(error => this.#diagnostic(errorCode(error), 'outbox')); }, this.pollMs);
      this.#timer.unref();
    }
    await Promise.all([
      this.catchUp().catch(error => this.#diagnostic(errorCode(error), 'receive')),
      this.flush().catch(error => this.#diagnostic(errorCode(error), 'outbox')),
      connectSocket ? this.waitForConnect().catch(error => this.#diagnostic(errorCode(error), 'connect')) : Promise.resolve(),
    ]);
    return this.status();
  }

  async #load() {
    const identity = { serverOrigin: this.serverOrigin, sessionId: this.sessionId, variant: this.#variant,
      keyFingerprint: createHash('sha256').update(this.#key).digest('hex') };
    let text = null;
    try { text = await readFile(this.statePath, 'utf8'); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
    if (text !== null) {
      let state;
      try { state = JSON.parse(text); } catch { throw new HappyTransportError('invalid-checkpoint', 'The owned transport checkpoint cannot be decoded.'); }
      if (state?.format !== 'happy-session-transport-v1' || canonical(state.identity) !== canonical(identity) || !Number.isSafeInteger(state.revision) || !Number.isSafeInteger(state.receiveCursor) || state.receiveCursor < 0 || !Array.isArray(state.outbox) || !Array.isArray(state.acknowledged) || !Array.isArray(state.inbox) || !state.fields) throw new HappyTransportError('checkpoint-identity-mismatch', 'The checkpoint format or origin/session/key identity does not match.');
      this.#state = state; this.#expectedStateText = text; return;
    }
    const initial = (/** @type {unknown} */ value, /** @type {unknown} */ version) => ({ version: boundedInteger(version, 0, 0, Number.MAX_SAFE_INTEGER), value: value === undefined || value === null ? null : encryptRecord(value, this.#key, this.#variant) });
    this.#state = { format: 'happy-session-transport-v1', identity, revision: 0, receiveCursor: 0,
      outbox: [], acknowledged: [], inbox: [], fields: {
        metadata: initial(this.#options.initialMetadata, this.#options.metadataVersion),
        agentState: initial(this.#options.initialAgentState, this.#options.agentStateVersion),
      } };
    await this.#write(this.#state);
  }

  /** @param {Value} next */
  async #write(next) {
    let existing = null;
    try { existing = await readFile(this.statePath, 'utf8'); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
    if (existing !== this.#expectedStateText) throw new HappyTransportError('checkpoint-conflict', 'The owned checkpoint changed outside this transport.');
    const folder = dirname(this.statePath);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`, text = JSON.stringify(next);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close();
      await rename(temporary, this.statePath);
      const directory = await open(folder, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      this.#expectedStateText = text;
    } catch (error) { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  }

  /** @template T @param {(next:Value)=>T} change @returns {Promise<T>} */
  #mutate(change) {
    const operation = this.#ioTail.catch(() => {}).then(async () => {
      this.#requireReady();
      const next = structuredClone(this.#state), result = change(next);
      if (next.outbox.length + next.acknowledged.length + next.inbox.length > this.maxJournalEntries) throw new HappyTransportError('checkpoint-capacity', 'The transport journal reached its explicit capacity.');
      next.revision += 1; await this.#write(next); this.#state = next;
      return result;
    });
    this.#ioTail = operation.then(() => {}, () => {}); return operation;
  }

  #requireReady() {
    if (!this.#started || !this.#state) throw new HappyTransportError('transport-not-started', 'Start the transport before using it.');
    if (this.#closed) throw new HappyTransportError('transport-closed', 'The transport is closed.');
  }
  /** @param {string} code @param {string} scope */
  #diagnostic(code, scope) { this.#lastErrorCode = code; this.emit('diagnostic', { code, scope, at: Date.now() }); }
  /** @param {unknown} record */
  #digest(record) { return createHmac('sha256', this.#key).update(canonical(JSON.parse(jsonText(record)))).digest('hex'); }

  /** Durably stages the ciphertext before attempting Happy log delivery. @param {string} localId @param {unknown} record @returns {Promise<MessageAck>} */
  async publish(localId, record) {
    this.#requireReady(); requiredString(localId, 'stable localId');
    if (localId.length > 256) throw new HappyTransportError('invalid-local-id', 'Use a bounded stable localId.');
    const digest = this.#digest(record);
    const memo = this.#state.acknowledged.find((/** @type {Value} */ item) => item.localId === localId);
    if (memo) {
      if (memo.digest !== digest) throw new HappyTransportError('record-conflict', 'The stable localId was reused for different content.');
      return structuredClone(memo.ack);
    }
    const saved = await this.#mutate(state => {
      const existing = [...state.outbox, ...state.acknowledged].find((/** @type {Value} */ message) => message.localId === localId);
      if (existing && existing.digest !== digest) throw new HappyTransportError('record-conflict', 'The stable localId was reused for different content.');
      if (existing) return existing;
      const pending = { localId, digest, content: encryptRecord(record, this.#key, this.#variant) };
      state.outbox.push(pending); return pending;
    });
    if (saved.ack) return structuredClone(saved.ack);
    await this.flush();
    let acknowledged = this.#state.acknowledged.find((/** @type {Value} */ item) => item.localId === localId);
    if (!acknowledged && this.#state.outbox.some((/** @type {Value} */ item) => item.localId === localId)) {
      await this.flush(); acknowledged = this.#state.acknowledged.find((/** @type {Value} */ item) => item.localId === localId);
    }
    if (!acknowledged) throw new HappyTransportError('message-unacknowledged', 'The record remains durably queued for Happy sync.');
    return structuredClone(acknowledged.ack);
  }

  /** Stage an ordered observer batch atomically, preserving retry ciphertext and IDs.
   * @param {{localId:string,record:unknown}[]} records @returns {Promise<MessageAck[]>} */
  async publishBatch(records) {
    this.#requireReady();
    if (!Array.isArray(records) || records.length > 50 * 100) throw new HappyTransportError('invalid-batch', 'Use a bounded observer batch.');
    const plans = records.map(({ localId, record }) => {
      requiredString(localId, 'stable localId');
      if (localId.length > 256) throw new HappyTransportError('invalid-local-id', 'Use a bounded stable localId.');
      return { localId, record, digest: this.#digest(record) };
    });
    const memo = new Map(this.#state.acknowledged.map((/** @type {Value} */ item) => [item.localId, item]));
    if (plans.every(plan => memo.get(plan.localId)?.digest === plan.digest)) return plans.map(plan => structuredClone(memo.get(plan.localId).ack));
    // 原 observer 逐条等待 POST，首份长历史产生数百次请求；一次持久化固定批次后再发送，ACK 丢失仍复用原密文。
    await this.#mutate(state => {
      const existing = new Map([...state.outbox, ...state.acknowledged].map((/** @type {Value} */ item) => [item.localId, item]));
      for (const plan of plans) {
        const previous = existing.get(plan.localId);
        if (previous && previous.digest !== plan.digest) throw new HappyTransportError('record-conflict', 'The stable localId was reused for different content.');
        if (!previous) {
          const pending = { localId: plan.localId, digest: plan.digest, content: encryptRecord(plan.record, this.#key, this.#variant) };
          state.outbox.push(pending); existing.set(plan.localId, pending);
        }
      }
    });
    await this.flush();
    let acknowledged = new Map(this.#state.acknowledged.map((/** @type {Value} */ item) => [item.localId, item]));
    if (plans.some(plan => !acknowledged.has(plan.localId))) {
      await this.flush(); acknowledged = new Map(this.#state.acknowledged.map((/** @type {Value} */ item) => [item.localId, item]));
    }
    return plans.map(plan => {
      const item = acknowledged.get(plan.localId);
      if (!item) throw new HappyTransportError('message-unacknowledged', 'The record remains durably queued for Happy sync.');
      return structuredClone(item.ack);
    });
  }

  flush() {
    this.#requireReady();
    if (this.#flushFlight) return this.#flushFlight;
    this.#flushFlight = this.#flush().finally(() => { this.#flushFlight = null; }); return this.#flushFlight;
  }

  async #flush() {
    let acknowledged = 0;
    while (!this.#closed && this.#state.outbox.length) {
      /** @type {Value[]} */ const batch = []; let bytes = 0;
      for (const item of this.#state.outbox) {
        const size = item.content.length + item.localId.length + 64;
        if (batch.length && (batch.length >= 50 || bytes + size > 256 * 1024)) break;
        batch.push(item); bytes += size;
      }
      const result = await this.#json(`/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`, { method: 'POST', body: JSON.stringify({ messages: batch.map((/** @type {Value} */ item) => ({ localId: item.localId, content: item.content })) }) });
      if (!Array.isArray(result.messages)) throw new HappyTransportError('invalid-sync-response', 'Happy did not return message acknowledgments.');
      const acks = new Map(result.messages.map((/** @type {Value} */ message) => [message.localId, this.#ack(message)]));
      if (batch.some((/** @type {Value} */ item) => !acks.has(item.localId))) throw new HappyTransportError('invalid-sync-response', 'A Happy message acknowledgment is missing.');
      await this.#mutate(state => {
        for (const pending of batch) {
          const index = state.outbox.findIndex((/** @type {Value} */ item) => item.localId === pending.localId);
          if (index < 0) continue;
          state.outbox.splice(index, 1); state.acknowledged.push({ localId: pending.localId, digest: pending.digest, ack: acks.get(pending.localId) });
        }
      });
      acknowledged += batch.length;
      // 自己POST的seq不能推进receive cursor；另一端更早到达的用户输入仍须真正capture。
    }
    return { acknowledged, pending: this.#state.outbox.length };
  }

  /** @param {Value} message @returns {MessageAck} */
  #ack(message) {
    if (typeof message.id !== 'string' || !Number.isSafeInteger(message.seq) || message.seq < 1 || typeof message.localId !== 'string' || !Number.isFinite(message.createdAt) || !Number.isFinite(message.updatedAt)) throw new HappyTransportError('invalid-sync-response', 'The Happy message identity is invalid.');
    return { id: message.id, seq: message.seq, localId: message.localId, createdAt: message.createdAt, updatedAt: message.updatedAt };
  }

  catchUp() {
    this.#requireReady();
    if (this.#receiveFlight) return this.#receiveFlight;
    this.#receiveFlight = this.#catchUp().finally(() => { this.#receiveFlight = null; }); return this.#receiveFlight;
  }

  async #catchUp() {
    let received = 0;
    while (!this.#closed) {
      const after = this.#state.receiveCursor;
      const page = await this.#json(`/v3/sessions/${encodeURIComponent(this.sessionId)}/messages?after_seq=${after}&limit=100`);
      if (!Array.isArray(page.messages)) throw new HappyTransportError('invalid-sync-response', 'Happy did not return a message page.');
      /** @type {EncryptedMessage[]} */ const incoming = [];
      let expected = after + 1;
      for (const message of page.messages) {
        if (!Number.isSafeInteger(message.seq) || message.seq !== expected || typeof message.id !== 'string' || (message.localId != null && typeof message.localId !== 'string') || message.content?.t !== 'encrypted' || typeof message.content.c !== 'string' || !Number.isFinite(message.createdAt) || !Number.isFinite(message.updatedAt)) throw new HappyTransportError('receive-gap-or-malformed-record', 'The Happy page has a gap or invalid outer record.');
        incoming.push({ id: message.id, seq: message.seq, localId: message.localId ?? null,
          content: { t: 'encrypted', c: message.content.c }, createdAt: message.createdAt, updatedAt: message.updatedAt }); expected += 1;
      }
      if (incoming.length) {
        await this.#mutate(state => { state.inbox.push(...incoming); state.receiveCursor = incoming[incoming.length - 1].seq; });
        // 只发新capture观察；恢复的inbox必须由Root先核对native journal，不能自动再次admit。
        if (!this.#closed) for (const raw of incoming) this.emit('record', this.#decodeIncoming(raw));
        received += incoming.length;
      }
      if (!page.hasMore) break;
      if (!incoming.length) throw new HappyTransportError('receive-pagination-stalled', 'The Happy receive page did not advance.');
    }
    return { received, cursor: this.#state.receiveCursor };
  }

  /** @param {EncryptedMessage} raw @returns {IncomingRecord} */
  #decodeIncoming(raw) {
    const record = decryptRecord(raw.content.c, this.#key, this.#variant);
    const publishedByThisTransport = raw.localId !== null && [...this.#state.outbox, ...this.#state.acknowledged].some((/** @type {Value} */ item) => item.localId === raw.localId);
    return { ...structuredClone(raw), record, publishedByThisTransport, ...(record === null ? { decodeError: 'invalid-encrypted-record' } : {}) };
  }
  listInbox() { this.#requireReady(); return this.#state.inbox.map((/** @type {EncryptedMessage} */ raw) => this.#decodeIncoming(raw)); }
  /** @param {string} id */
  ackInbox(id) { return this.#mutate(state => { const index = state.inbox.findIndex((/** @type {Value} */ item) => item.id === id); if (index >= 0) state.inbox.splice(index, 1); return index >= 0; }); }

  #connectSocket() {
    this.#socket = io(this.serverOrigin, { path: '/v1/updates', auth: { token: this.#token, clientType: 'session-scoped', sessionId: this.sessionId, happyClient: 'noninvasive-transport/1' }, transports: ['websocket'], autoConnect: false, reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
    this.#socket.on('connect', () => {
      if (this.#closed) { this.#socket?.close(); return; }
      for (const method of this.#rpcHandlers.keys()) this.#socket?.emit('rpc-register', { method: `${this.sessionId}:${method}` });
      this.emit('connected'); this.catchUp().catch(error => this.#diagnostic(errorCode(error), 'receive')); this.flush().catch(error => this.#diagnostic(errorCode(error), 'outbox'));
    });
    this.#socket.on('disconnect', () => this.emit('disconnected'));
    this.#socket.on('connect_error', () => this.#diagnostic('sync-connect-error', 'connect'));
    this.#socket.on('update', (/** @type {Value} */ update) => {
      if (this.#closed) return;
      const body = update?.body;
      if (body?.t === 'new-message' && body.sid === this.sessionId) this.catchUp().catch(error => this.#diagnostic(errorCode(error), 'receive'));
      if (body?.t === 'update-session' && body.id === this.sessionId) {
        for (const field of ['metadata', 'agentState']) if (body[field]) this.#cacheField(field, body[field]).catch(error => this.#diagnostic(errorCode(error), 'state'));
      }
    });
    this.#socket.on('rpc-request', (/** @type {Value} */ request, /** @type {(response:string)=>void} */ callback) => { this.#serveRpc(request).then(callback).catch(() => callback(encryptRecord({ ok: false, error: { code: 'rpc-transport-error', message: 'The encrypted RPC could not complete.' }, effectMayHaveOccurred: true }, this.#key, this.#variant))); });
    this.#socket.connect();
  }

  /** @param {number} [timeoutMs] @returns {Promise<void>} */
  waitForConnect(timeoutMs = this.requestTimeoutMs) {
    if (this.#socket?.connected) return Promise.resolve();
    return new Promise((resolveConnect, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new HappyTransportError('sync-connect-timeout', 'Happy sync did not connect.')); }, timeoutMs);
      const onConnect = () => { cleanup(); resolveConnect(); };
      const onClose = () => { cleanup(); reject(new HappyTransportError('transport-closed', 'The transport closed before connecting.')); };
      const cleanup = () => { clearTimeout(timer); this.removeListener('connected', onConnect); this.removeListener('closing', onClose); };
      this.once('connected', onConnect);
      this.once('closing', onClose);
    });
  }

  /** @param {string} method @param {RpcHandler} handler */
  registerRpc(method, handler) {
    if (this.#closed) throw new HappyTransportError('transport-closed', 'The transport is closed.');
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(method) || typeof handler !== 'function') throw new HappyTransportError('invalid-rpc-method', 'Register an explicit bounded RPC handler.');
    if (this.#rpcHandlers.has(method)) throw new HappyTransportError('rpc-already-registered', 'The RPC method already has a handler.');
    this.#rpcHandlers.set(method, handler);
    if (this.#socket?.connected) this.#socket.emit('rpc-register', { method: `${this.sessionId}:${method}` });
    return () => { if (this.#rpcHandlers.get(method) !== handler) return; this.#rpcHandlers.delete(method); this.#socket?.emit('rpc-unregister', { method: `${this.sessionId}:${method}` }); };
  }

  /** Explicit Root-provided receipt lookup only; no native dispatch is built in. @param {RpcHandler} handler */
  registerReceiptHandler(handler) {
    if (this.#rpcHandlers.has('bridge-receipt') || this.#rpcHandlers.has('receipt')) throw new HappyTransportError('rpc-already-registered', 'The receipt channel already has a handler.');
    const a = this.registerRpc('bridge-receipt', handler), b = this.registerRpc('receipt', handler);
    return () => { a(); b(); };
  }

  /** Happy connector presence only; never a native running/admission claim. @param {boolean} [thinking] @param {'local'|'remote'} [mode] */
  keepAlive(thinking = false, mode = 'local') {
    this.#requireReady();
    if (typeof thinking !== 'boolean' || !['local', 'remote'].includes(mode)) throw new HappyTransportError('invalid-presence', 'Happy presence requires a boolean activity and known mode.');
    if (!this.#socket?.connected) return false;
    this.#socket.volatile.emit('session-alive', { sid: this.sessionId, time: Date.now(), thinking, mode });
    return true;
  }

  /** @param {Value} request */
  async #serveRpc(request) {
    let invoked = false;
    try {
      if (this.#closed) throw new HappyTransportError('transport-closed', 'The transport is closed.');
      const prefix = `${this.sessionId}:`, method = typeof request.method === 'string' && request.method.startsWith(prefix) ? request.method.slice(prefix.length) : '';
      const handler = this.#rpcHandlers.get(method);
      if (!handler) throw new HappyTransportError('rpc-method-unregistered', 'This RPC method is not registered.');
      if (typeof request.params !== 'string') throw new HappyTransportError('invalid-rpc-params', 'Encrypted RPC params are required.');
      const params = decryptRecord(request.params, this.#key, this.#variant);
      if (params === null) throw new HappyTransportError('invalid-rpc-params', 'The encrypted RPC params could not be decoded.');
      invoked = true;
      return encryptRecord(await handler(params, { sessionId: this.sessionId, method }), this.#key, this.#variant);
    } catch (error) {
      const coded = /** @type {Value} */ (error);
      const code = typeof coded?.code === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(coded.code) ? coded.code : 'rpc-handler-error';
      return encryptRecord({ ok: false, error: { code, message: error instanceof Error ? error.message.slice(0, 500) : 'The RPC could not complete.' }, effectMayHaveOccurred: typeof coded?.effectMayHaveOccurred === 'boolean' ? coded.effectMayHaveOccurred : invoked }, this.#key, this.#variant);
    }
  }

  /** No automatic retries or offline socket buffering. @param {string} method @param {unknown} params */
  async callRpc(method, params) {
    this.#requireReady();
    const socket = this.#socket;
    if (!socket?.connected) throw new HappyTransportError('rpc-disconnected', 'Happy sync is not connected.');
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(method)) throw new HappyTransportError('invalid-rpc-method', 'Use a bounded RPC method.');
    let answer;
    try { answer = await socket.timeout(this.requestTimeoutMs).emitWithAck('rpc-call', { method: `${this.sessionId}:${method}`, params: encryptRecord(params, this.#key, this.#variant) }); }
    catch { throw new HappyTransportError('delivery-unknown', 'The RPC may have been delivered; query its stable receipt before retrying.', true); }
    if (answer?.ok !== true) {
      if (answer?.error === 'RPC method not available') throw new HappyTransportError('rpc-not-available', 'The RPC method is unavailable.');
      throw new HappyTransportError('delivery-unknown', 'The RPC result could not be confirmed; query its stable receipt before retrying.', true);
    }
    const result = typeof answer.result === 'string' ? decryptRecord(answer.result, this.#key, this.#variant) : null;
    if (result === null) throw new HappyTransportError('delivery-unknown', 'The encrypted RPC reply could not be decoded.', true);
    if (result && typeof result === 'object' && /** @type {Value} */ (result).ok === false && /** @type {Value} */ (result).error) {
      const reply = /** @type {Value} */ (result);
      throw new HappyTransportError(reply.error.code ?? 'rpc-handler-error', reply.error.message ?? 'The RPC failed.', reply.effectMayHaveOccurred === true);
    }
    return result;
  }

  /** @param {string} field @param {Value} value */
  #cacheField(field, value) {
    if (!Number.isSafeInteger(value.version) || value.version < 0 || (value.value !== null && typeof value.value !== 'string')) return Promise.reject(new HappyTransportError('invalid-state-update', 'Happy sent an invalid state version.'));
    return this.#mutate(state => { if (value.version > state.fields[field].version) state.fields[field] = { version: value.version, value: value.value }; }).then(() => { this.emit('state', { field, version: this.#state.fields[field].version, value: this.#state.fields[field].value ? decryptRecord(this.#state.fields[field].value, this.#key, this.#variant) : null }); });
  }
  /** @param {Value|((value:Value)=>Value|Promise<Value>)} value */
  updateMetadata(value) { return this.#updateField('metadata', value); }
  /** @param {Value|null|((value:Value)=>Value|null|Promise<Value|null>)} value */
  updateAgentState(value) { return this.#updateField('agentState', value); }

  /** @param {string} field @param {unknown|((value:Value)=>unknown)} value */
  #updateField(field, value) {
    const previous = this.#fieldFlights.get(field) ?? Promise.resolve();
    const flight = previous.catch(() => {}).then(async () => {
      this.#requireReady();
      for (let attempt = 0; attempt < 5; attempt++) {
        const socket = this.#socket;
        if (!socket?.connected) throw new HappyTransportError('sync-disconnected', 'Happy sync is not connected.');
        const current = this.#state.fields[field], decoded = current.value ? decryptRecord(current.value, this.#key, this.#variant) : null;
        const updated = typeof value === 'function' ? await value(decoded ?? {}) : value;
        if (updated === undefined) throw new HappyTransportError('invalid-state-update', 'Return an explicit state object or null from the state updater.');
        if (field === 'metadata' && (updated === null || updated === undefined)) throw new HappyTransportError('invalid-metadata', 'Happy metadata cannot be empty.');
        // 相同 plaintext 不应换 nonce、递增字段版本并重写整份 transport。
        if (canonical(JSON.parse(jsonText(updated))) === canonical(decoded)) return decoded;
        const encrypted = updated == null ? null : encryptRecord(updated, this.#key, this.#variant);
        let answer;
        try { answer = await socket.timeout(this.requestTimeoutMs).emitWithAck(field === 'metadata' ? 'update-metadata' : 'update-state', { sid: this.sessionId, expectedVersion: current.version, ...(field === 'metadata' ? { metadata: encrypted } : { agentState: encrypted }) }); }
        catch { throw new HappyTransportError('sync-state-unconfirmed', 'The Happy state update result was not confirmed.'); }
        if (!Number.isSafeInteger(answer?.version) || !['success', 'version-mismatch'].includes(answer?.result)) throw new HappyTransportError('invalid-state-update', 'Happy rejected the state update.');
        const returned = field === 'metadata' ? answer.metadata : answer.agentState;
        if (returned !== null && typeof returned !== 'string') throw new HappyTransportError('invalid-state-update', 'Happy returned an invalid encrypted state.');
        await this.#mutate(state => { if (answer.version >= state.fields[field].version) state.fields[field] = { version: answer.version, value: returned }; });
        if (answer.result === 'success') return this.#state.fields[field].value ? decryptRecord(this.#state.fields[field].value, this.#key, this.#variant) : null;
      }
      throw new HappyTransportError('state-version-conflict', 'Happy state kept changing; retry after reading its current version.');
    });
    this.#fieldFlights.set(field, flight); return flight;
  }

  /** @param {Uint8Array} data @param {{filename:string}} options */
  async uploadAttachment(data, options) {
    this.#requireReady();
    if (!(data instanceof Uint8Array) || data.length > MAX_ATTACHMENT_BYTES - 40) throw new HappyTransportError('attachment-too-large', 'The encrypted Happy attachment must fit the 10 MiB bound.');
    const encrypted = encryptBlob(data, deriveBlobKey(this.#key, this.#variant));
    const upload = await this.#json(`/v1/sessions/${this.sessionId}/attachments/request-upload`, { method: 'POST', body: JSON.stringify({ filename: requiredString(options.filename, 'attachment filename'), size: encrypted.length }) });
    this.#attachmentRef(upload.ref);
    if (!['PUT', 'POST'].includes(upload.method)) throw new HappyTransportError('invalid-attachment-response', 'Happy returned an unsupported upload method.');
    const body = upload.method === 'POST' ? new FormData() : encrypted;
    if (body instanceof FormData) {
      for (const [name, value] of Object.entries(upload.formFields ?? {})) { if (typeof value !== 'string') throw new HappyTransportError('invalid-attachment-response', 'Happy returned invalid upload fields.'); body.append(name, value); }
      body.append('file', new Blob([Buffer.from(encrypted)], { type: 'application/octet-stream' }), 'blob');
    }
    await this.#fetch(upload.uploadUrl, { method: upload.method, body, ...(upload.method === 'PUT' ? { headers: { 'Content-Type': 'application/octet-stream' } } : {}) }, MAX_RESPONSE_BYTES);
    return { ref: upload.ref, size: data.length };
  }

  /** @param {string} ref */
  async downloadAttachment(ref) {
    this.#requireReady(); this.#attachmentRef(ref);
    const answer = await this.#json(`/v1/sessions/${this.sessionId}/attachments/request-download`, { method: 'POST', body: JSON.stringify({ ref }) });
    const encrypted = await this.#fetch(answer.downloadUrl, {}, MAX_ATTACHMENT_BYTES);
    const plain = decryptBlob(encrypted, deriveBlobKey(this.#key, this.#variant));
    if (!plain) throw new HappyTransportError('attachment-decrypt-failed', 'The encrypted attachment could not be decoded.');
    return plain;
  }

  /** @param {unknown} ref */
  #attachmentRef(ref) {
    const prefix = `sessions/${this.sessionId}/attachments/`;
    if (typeof ref !== 'string' || !ref.startsWith(prefix) || !/^[a-f0-9-]{36}\.enc$/u.test(ref.slice(prefix.length))) throw new HappyTransportError('invalid-attachment-ref', 'The attachment must belong to this Happy session.');
  }

  /** @param {string} path @param {RequestInit} [options] @returns {Promise<Value>} */
  async #json(path, options = {}) {
    const bytes = await this.#fetch(`${this.serverOrigin}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }, MAX_RESPONSE_BYTES);
    try { const result = JSON.parse(Buffer.from(bytes).toString('utf8')); if (!result || typeof result !== 'object') throw Error(); return result; }
    catch { throw new HappyTransportError('invalid-sync-response', 'Happy sync returned an invalid JSON response.'); }
  }

  /** @param {string} target @param {RequestInit} options @param {number} limit */
  async #fetch(target, options, limit) {
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HappyTransportError('invalid-sync-url', 'Happy returned an invalid transfer URL.');
    const controller = new AbortController(); this.#requests.add(controller);
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const headers = new Headers(options.headers);
      if (url.origin === this.serverOrigin) headers.set('Authorization', `Bearer ${this.#token}`);
      else headers.delete('Authorization');
      let response;
      try { response = await fetch(url, { ...options, headers, signal: controller.signal, redirect: 'error' }); }
      catch { throw new HappyTransportError('sync-network-error', 'The Happy sync request did not complete.'); }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new HappyTransportError('sync-http-error', `Happy sync returned HTTP ${response.status}.`); }
      const reader = response.body?.getReader();
      if (!reader) return new Uint8Array();
      /** @type {Uint8Array[]} */ const chunks = []; let size = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw new HappyTransportError('sync-response-limit', 'The Happy response exceeds its bounded size.'); } chunks.push(value); }
      } catch (error) {
        if (error instanceof HappyTransportError) throw error;
        throw new HappyTransportError('sync-network-error', 'The Happy response body did not complete.');
      } finally { reader.releaseLock(); }
      return new Uint8Array(Buffer.concat(chunks, size));
    } finally { clearTimeout(timer); this.#requests.delete(controller); }
  }

  close() {
    if (this.#closeFlight) return this.#closeFlight;
    this.#closeFlight = this.#close(); return this.#closeFlight;
  }
  async #close() {
    this.#closed = true;
    this.emit('closing');
    if (this.#timer) clearInterval(this.#timer);
    this.#socket?.close();
    for (const request of this.#requests) request.abort();
    await Promise.allSettled([this.#startFlight, this.#receiveFlight, this.#flushFlight, ...this.#fieldFlights.values()]);
    await this.#ioTail;
    if (this.#started) stateOwners.delete(this.statePath);
    this.emit('closed');
  }
}
