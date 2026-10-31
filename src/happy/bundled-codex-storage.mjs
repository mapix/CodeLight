import { Worker } from 'node:worker_threads';
import { SessionStorage } from '../storage.mjs';
import { BridgeError } from '../errors.mjs';
import { resolveCodeLightProjects } from './project-identity.mjs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Mac package index adapter: asynchronous worker IO, no external Python runtime. */
export class BundledCodexStorage extends SessionStorage {
  /** @param {{codex?:string,zcode?:string,python?:string,loadIndex?:(offset:number)=>Promise<Record<string,any>[]>,signature?:()=>Promise<string>,now?:()=>number}} [options] */
  constructor(options = {}) {
    super(options);
    this.loader = options.loadIndex ?? (offset => this.readIndex(offset));
    this.signature = options.signature ?? (() => this.indexSignature());
    this.now = options.now ?? Date.now;
    /** @type {Map<number,{signature:string,until:number,rows:Record<string,any>[]}>} */ this.cache = new Map();
    /** @type {Map<string,Promise<Record<string,any>[]>>} */ this.flights = new Map();
    /** @type {Map<number,number>} */ this.versions = new Map();
  }
  async indexSignature() {
    const values = await Promise.all(['state_5.sqlite', 'state_5.sqlite-wal', '.codex-global-state.json'].map(async name => {
      try { const file = await stat(join(this.roots.codex, name), { bigint: true }); return `${name}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`; }
      catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' && name !== 'state_5.sqlite') return `${name}:missing`; throw error; }
    }));
    return values.join('|');
  }
  /** @param {'codex'|'zcode'} app @param {number} [offset] @returns {Promise<Record<string,any>[]>} */
  async list(app, offset = 0) {
    if (app !== 'codex') throw new BridgeError('unsupported-source', 'The Mac package exposes Codex sessions.');
    const signature = await this.signature(), saved = this.cache.get(offset);
    if (saved?.signature === signature && saved.until > this.now()) return structuredClone(saved.rows);
    const key = signature + ':' + offset;
    let flight = this.flights.get(key);
    if (!flight) {
      const version = (this.versions.get(offset) ?? 0) + 1; this.versions.set(offset, version);
      const operation = this.loader(offset).then(rows => {
        if (this.versions.get(offset) === version) {
          this.cache.delete(offset); this.cache.set(offset, { signature, until: this.now() + 60000, rows });
          while (this.cache.size > 8) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cache.delete(oldest); this.versions.delete(oldest);
          }
        }
        return rows;
      }).finally(() => { if (this.flights.get(key) === operation) this.flights.delete(key); });
      flight = operation; this.flights.set(key, flight);
    }
    return structuredClone(await flight);
  }
  /** @param {number} offset @returns {Promise<Record<string,any>[]>} */
  async readIndex(offset) {
    const rows = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./codex-index-worker.mjs', import.meta.url), { execArgv: [], workerData: { root: this.roots.codex, offset } });
      worker.once('message', value => value.ok ? resolve(value.rows) : reject(new BridgeError('session-store-unavailable', 'The Codex index could not be read.')));
      worker.once('error', () => reject(new BridgeError('session-store-unavailable', 'The Codex index worker failed.')));
    });
    return resolveCodeLightProjects(rows, this.roots.codex);
  }
}
