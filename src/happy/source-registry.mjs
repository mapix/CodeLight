import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeDurablePrivateJson as writePrivateJson } from './discovery-persistence.mjs';
import { deriveContentKeyPair, encryptRecord, sealDataKey, unsealDataKey, decryptRecord } from './session-transport.mjs';
import { isCodeLightCodexSource } from './source-scope.mjs';

/** @typedef {Record<string,any>} Value */
export const SOURCE_APPS = Object.freeze(['codex', 'zcode', 'claude-desktop', 'cursor', 'antigravity', 'windsurf', 'vscode', 'zed', 'trae', 'terminal', 'iterm', 'warp']);
/** @param {Value} source */
function projectMetadata(source) { return source.project ? { projectKey: source.project.key, projectPath: source.project.path, projectLabel: source.project.label } : {}; }
/** Stable source identity includes the host: equal filesystem paths are not identities. @param {Value} source */
export function sourceKey(source) {
  if (!SOURCE_APPS.includes(source.app) || typeof source.id !== 'string' || !source.id || typeof source.hostId !== 'string' || !source.hostId) throw Error('A verified application/source/host identity is required.');
  return createHash('sha256').update(JSON.stringify([source.app, source.hostId, source.id])).digest('hex');
}

export class SourceRegistry {
  /** @param {{directory:string,account:Value,fetch?:typeof fetch,allowDeferredSources?:boolean}} options */
  constructor(options) {
    this.directory = resolve(options.directory); this.account = options.account; this.fetch = options.fetch ?? fetch;
    this.allowDeferredSources = options.allowDeferredSources === true;
    this.flights = /** @type {Map<string,Promise<Value>>} */ (new Map());
    this.metadataFlights = /** @type {Map<string,Promise<void>>} */ (new Map());
  }
  /** @param {Value} source @param {unknown} [metadata] */
  assertScope(source, metadata) {
    if (!this.allowDeferredSources && !isCodeLightCodexSource(source, metadata)) throw Object.assign(Error('Only native Codex session sources are supported.'), { code: 'unsupported-source' });
  }
  fingerprint() { const key = Buffer.from(this.account.secret ?? '', 'base64url'); if (key.length !== 32) throw Error('The CodeLight account key is invalid.'); return createHash('sha256').update(key).digest('hex'); }
  /** Read-only cold-start candidates; the caller confirms current machine ownership.
   * @returns {Promise<Value[]>} */
  async savedBindings() {
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return []; throw error; }
    const files = entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).map(entry => entry.name).sort();
    const accountFingerprint = this.fingerprint(), bindings = /** @type {Value[]} */ ([]);
    // 冷启动只读已提交 binding；限制并发文件读取，原子写入留下的临时文件不参与恢复。
    for (let offset = 0; offset < files.length; offset += 32) {
      const batch = await Promise.all(files.slice(offset, offset + 32).map(async file => {
        const bindingPath = join(this.directory, file), key = file.slice(0, -5);
        try {
          const saved = /** @type {Value} */ (JSON.parse(await readFile(bindingPath, 'utf8')));
          if (typeof saved?.happySessionId !== 'string' || !saved.happySessionId ||
            saved.accountFingerprint !== accountFingerprint || saved.serverUrl !== this.account.serverUrl ||
            typeof saved.machineId !== 'string' || !saved.machineId ||
            typeof saved.sessionKey !== 'string' || Buffer.from(saved.sessionKey, 'base64').length !== 32 ||
            (saved.metadataVersion !== undefined && (!Number.isSafeInteger(saved.metadataVersion) || saved.metadataVersion < 0)) ||
            !isCodeLightCodexSource(saved.source, saved.metadata) || sourceKey(saved.source) !== key) return null;
          const metadata = this.checkedMetadata(saved, saved.metadata);
          if (!isCodeLightCodexSource(metadata.bridge.source, metadata) || sourceKey(metadata.bridge.source) !== key ||
            (metadata.bridge.sourceKey !== undefined && metadata.bridge.sourceKey !== key)) return null;
          return { ...saved, bindingPath };
        } catch { return null; }
      }));
      for (const binding of batch) if (binding) bindings.push(binding);
    }
    return bindings;
  }
  /** @param {string} path @param {Value} body */
  async post(path, body) {
    const response = await this.fetch(`${this.account.serverUrl}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${this.account.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error(`CodeLight source registration failed (${response.status}).`);
    return /** @type {Value} */ (await response.json());
  }
  /** Registers only presence; this machine never advertises a model runner. */
  async machine() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'machine.json');
    let saved; try { saved = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; saved = { id: randomUUID() }; }
    const accountFingerprint = this.fingerprint(); if (saved.accountFingerprint && saved.accountFingerprint !== accountFingerprint) throw Error('This machine profile belongs to another CodeLight account.');
    const metadata = { host: 'CodeLight Mac', platform: process.platform, arch: process.arch, happyCliVersion: 'codelight/0.2.0',
      happyHomeDir: this.directory, homeDir: this.directory, machineKind: 'noninvasive-bridge', displayName: 'CodeLight Mac',
      codeLight: { codexOnly: true, projectActivityVersion: 1 },
      cliAvailability: { codex: false, claude: false, gemini: false, openclaw: false, rig: false, detectedAt: Date.now() } };
    // Stable machine identity is durable before the first network attempt.
    await writePrivateJson(path, { ...saved, accountFingerprint, metadata });
    const { machine } = await this.post('/v1/machines', { id: saved.id, metadata: encryptRecord(metadata, new Uint8Array(Buffer.from(this.account.secret, 'base64url')), 'legacy') });
    await writePrivateJson(path, { ...saved, accountFingerprint, metadata, record: machine });
    return { ...saved, accountFingerprint, metadata, record: machine };
  }
  /** @param {Value} source @param {string} machineId @returns {Promise<Value>} */
  register(source, machineId) {
    this.assertScope(source, source.metadata);
    const key = sourceKey(source);
    if (this.flights.has(key)) return /** @type {Promise<Value>} */ (this.flights.get(key));
    const flight = this.registerSource(source, machineId).finally(() => this.flights.delete(key)); this.flights.set(key, flight); return flight;
  }
  /** @param {Value} source @param {string} machineId */
  async registerSource(source, machineId) {
    this.assertScope(source, source.metadata);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${sourceKey(source)}.json`);
    let saved; try { saved = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
    const accountFingerprint = this.fingerprint(); if (saved?.accountFingerprint && saved.accountFingerprint !== accountFingerprint) throw Error('The source binding belongs to another CodeLight account.');
    if (saved?.happySessionId) {
      if (sourceKey(saved.source) !== sourceKey(source) || saved.serverUrl !== this.account.serverUrl || saved.machineId !== machineId) throw Error('The saved binding belongs to another source, server, or machine.');
      this.assertScope(saved.source, saved.metadata);
      return { ...saved, bindingPath: path };
    }
    const tag = `codelight:${machineId}:${sourceKey(source)}`;
    const metadata = saved?.metadata ?? { path: source.workspace ?? '', host: 'CodeLight Mac', flavor: source.app, machineId,
      summary: { text: source.title || source.app, updatedAt: source.updatedAt ?? Date.now() }, nativeSession: { title: source.title || source.app, updatedAt: source.updatedAt ?? Date.now(), parentId: source.parentId ?? null, agentName: source.agentName ?? '', preview: source.preview ?? '', isPinned: source.isPinned ?? false, catalogueAvailable: true, ...projectMetadata(source) }, client: { id: 'noninvasive-bridge', name: 'CodeLight', version: '0.2.0' },
      capabilities: { abort: false, attachments: { enabled: false, maxBytes: 0, mediaTypes: [] }, files: { browse: false, read: false, search: false, write: false }, messageReceipts: true,
        modelSelection: false, reasoningSelection: false, permissionModeSelection: false, resume: false, rpcMethods: [], shell: false, steering: false },
      bridge: { version: 1, source: { app: source.app, id: source.id, hostId: source.hostId, runtimeGeneration: source.runtimeGeneration ?? null, windowGeneration: source.windowGeneration ?? null },
        currentTurnId: null, controlMode: source.kind === 'window' || source.app !== 'codex' ? 'window' : 'session', sourceStatus: 'owner-unavailable',
        controller: 'machine', sourceKey: sourceKey(source) } };
    const pending = saved ?? { version: 1, tag, serverUrl: this.account.serverUrl, machineId, source: metadata.bridge.source, metadata, sessionKey: randomBytes(32).toString('base64') };
    this.assertScope(pending.source, metadata);
    pending.accountFingerprint = accountFingerprint;
    if (pending.tag !== tag || sourceKey(pending.source) !== sourceKey(source) || pending.serverUrl !== this.account.serverUrl) throw Error('The pending source plan does not match.');
    await writePrivateJson(path, pending);
    const secret = new Uint8Array(Buffer.from(this.account.secret, 'base64url')), pair = deriveContentKeyPair(secret), proposed = new Uint8Array(Buffer.from(pending.sessionKey, 'base64'));
    const { session } = await this.post('/v1/sessions', { tag, metadata: encryptRecord(metadata, proposed), dataEncryptionKey: Buffer.from(sealDataKey(proposed, pair.publicKey)).toString('base64') });
    // ACK loss/tag reuse must recover the server's original DEK, never replace it with a new random key.
    const key = unsealDataKey(new Uint8Array(Buffer.from(session.dataEncryptionKey ?? '', 'base64')), pair.secretKey);
    if (!key || !session.id) throw Error('The registered source encryption key could not be recovered.');
    const observedMetadata = /** @type {Value|null} */ (decryptRecord(session.metadata, key));
    if (!observedMetadata || sourceKey(observedMetadata.bridge.source) !== sourceKey(source)) throw Error('The existing server tag is bound to another source.');
    this.assertScope(observedMetadata.bridge.source, observedMetadata);
    const binding = { ...pending, happySessionId: session.id, sessionKey: Buffer.from(key).toString('base64'), metadata: observedMetadata };
    await writePrivateJson(path, binding);
    return { ...binding, bindingPath: path };
  }
  /** Discovery is the sole owner of index labels/recency; CAS preserves the active owner's capabilities.
   * @param {Value} binding @param {Value} source @param {import('socket.io-client').Socket} socket @returns {Promise<void>} */
  refreshMetadata(binding, source, socket) {
    this.assertScope(source, source.metadata);
    if (sourceKey(binding.source) !== sourceKey(source)) throw Error('The discovery source does not match its binding.');
    return this.queueMetadata(binding, socket, metadata => {
      const nativeSession = { ...metadata.nativeSession, title: source.title || source.app, updatedAt: source.updatedAt ?? 0,
        parentId: source.parentId ?? null, agentName: source.agentName ?? '', preview: source.preview ?? '', isPinned: source.isPinned ?? false,
        catalogueAvailable: true, ...projectMetadata(source) };
      if (!source.project) for (const field of ['projectKey', 'projectPath', 'projectLabel']) delete nativeSession[field];
      return { ...metadata, path: source.workspace ?? '', summary: { ...metadata.summary, text: nativeSession.title, updatedAt: nativeSession.updatedAt }, nativeSession };
    });
  }
  /** Confirmed index absence hides the catalog entry while retaining its owner/history evidence.
   * @param {Value} binding @param {import('socket.io-client').Socket} socket @returns {Promise<void>} */
  markUnavailable(binding, socket) {
    return this.queueMetadata(binding, socket, metadata => ({ ...metadata, nativeSession: { ...metadata.nativeSession, catalogueAvailable: false } }));
  }
  /** @param {Value} binding @param {import('socket.io-client').Socket} socket @param {(metadata:Value)=>Value} update @returns {Promise<void>} */
  queueMetadata(binding, socket, update) {
    this.assertScope(binding.source, binding.metadata);
    const key = binding.happySessionId;
    if (typeof key !== 'string' || !key) throw Error('A registered source binding is required.');
    // 移除与重发现共用同一写入队列，不能用不同快照并发覆盖 catalogue 状态。
    const previous = this.metadataFlights.get(key) ?? Promise.resolve();
    const flight = previous.catch(() => {}).then(() => this.updateMetadata(binding, socket, update));
    this.metadataFlights.set(key, flight);
    return flight.finally(() => { if (this.metadataFlights.get(key) === flight) this.metadataFlights.delete(key); });
  }
  /** @param {Value} binding @param {unknown} metadata @returns {Value} */
  checkedMetadata(binding, metadata) {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) throw Error('source-metadata-update-failed');
    const value = /** @type {Value} */ (metadata);
    if (!value.bridge?.source || sourceKey(value.bridge.source) !== sourceKey(binding.source)) throw Error('source-metadata-update-failed');
    this.assertScope(value.bridge.source, value);
    return value;
  }
  /** @param {Value} binding @param {Value} metadata @param {number} version */
  async saveMetadata(binding, metadata, version) {
    // 服务端 ACK 后仍可能持久化失败；先保存再推进内存，重试可从 CAS 冲突恢复最新证据。
    await writePrivateJson(binding.bindingPath, { ...binding, metadata, metadataVersion: version });
    binding.metadata = metadata; binding.metadataVersion = version;
  }
  /** @param {Value} binding @param {import('socket.io-client').Socket} socket @param {(metadata:Value)=>Value} update */
  async updateMetadata(binding, socket, update) {
    const key = new Uint8Array(Buffer.from(binding.sessionKey, 'base64'));
    let metadata = this.checkedMetadata(binding, binding.metadata), version = binding.metadataVersion ?? 0, observed = false;
    if (!Number.isSafeInteger(version) || version < 0) throw Error('source-metadata-update-failed');
    for (let attempt = 0; attempt < 5; attempt++) {
      const value = update(metadata);
      if (JSON.stringify(value) === JSON.stringify(metadata)) {
        if (observed) await this.saveMetadata(binding, metadata, version);
        return;
      }
      const answer = await socket.timeout(15000).emitWithAck('update-metadata', { sid: binding.happySessionId, expectedVersion: version, metadata: encryptRecord(value, key) });
      if (!Number.isSafeInteger(answer?.version) || answer.version < version || !['success', 'version-mismatch'].includes(answer.result) ||
        (answer.result === 'success' && answer.version === version)) throw Error('source-metadata-update-failed');
      metadata = this.checkedMetadata(binding, decryptRecord(answer.metadata, key)); version = answer.version; observed = true;
      const applied = JSON.stringify(update(metadata)) === JSON.stringify(metadata);
      if (answer.result === 'success' || applied) {
        if (!applied) throw Error('source-metadata-update-failed');
        await this.saveMetadata(binding, metadata, version); return;
      }
    }
    throw Error('source-metadata-conflict');
  }
}
