import { createHash } from 'node:crypto';
import { BridgeError } from './errors.mjs';
import { readFile } from 'node:fs/promises';
import { writePrivateJson } from './private-json.mjs';

/** @typedef {{id:string, status:'running'|'complete'|'failed'|'unknown', result?:unknown, error?:string, nativeCause?:string}} Receipt */

/** Preserve only a bounded error code; never persist native message text or private context. @param {unknown} value */
export function nativeCauseCode(value) { return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,79}$/u.test(value) ? value : undefined; }

export class CommandReceipts {
  constructor() {
    /** @type {Map<string,{digest:string,receipt:Receipt,flight:Promise<Receipt>}>} */
    this.commands = new Map();
    /** @type {Map<string,Promise<unknown>>} */
    this.tails = new Map();
    /** @type {string|null} */
    this.storePath = null;
    this.storeTail = Promise.resolve();
  }

  /** @param {string} path */
  static async load(path) {
    const registry = new CommandReceipts(); registry.storePath = path;
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(saved) || saved.length > 2048) throw Error('invalid-receipt-store');
      for (const item of saved) {
        if (typeof item.key !== 'string' || typeof item.digest !== 'string' || !item.receipt || !['running', 'complete', 'failed', 'unknown'].includes(item.receipt.status)) throw Error('invalid-receipt');
        const receipt = /** @type {Receipt} */ (item.receipt);
        const cause = nativeCauseCode(receipt.nativeCause);
        if (cause) receipt.nativeCause = cause; else delete receipt.nativeCause;
        if (receipt.status === 'running') { receipt.status = 'unknown'; receipt.error = 'bridge-restarted'; }
        registry.commands.set(item.key, { digest: item.digest, receipt, flight: Promise.resolve(receipt) });
      }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw new BridgeError('receipt-store-unavailable', '本机操作回执无法读取。', 503);
    }
    return registry;
  }

  persist() {
    if (!this.storePath) return Promise.resolve();
    const path = this.storePath;
    const operation = this.storeTail.then(() => writePrivateJson(path, [...this.commands].map(([key, item]) => ({ key, digest: item.digest, receipt: item.receipt }))));
    this.storeTail = operation.catch(() => {});
    return operation;
  }

  /** @param {string} scope @param {string} id @param {unknown} payload @param {()=>Promise<unknown>} execute */
  async run(scope, id, payload, execute) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new BridgeError('invalid-command-id', '操作地址无效。');
    const key = `${scope}:${id}`;
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const previous = this.commands.get(key);
    if (previous) {
      if (previous.digest !== hash) throw new BridgeError('command-conflict', '同一操作编号不能对应不同内容。', 409);
      return previous.flight;
    }
    if (this.commands.size >= 2048) {
      for (const [oldKey, old] of this.commands) {
        if (old.receipt.status !== 'running') { this.commands.delete(oldKey); break; }
      }
      if (this.commands.size >= 2048) throw new BridgeError('busy', '服务繁忙，请稍后重试。', 503);
    }
    const receipt = /** @type {Receipt} */ ({ id, status: 'running' });
    const tail = this.tails.get(scope) ?? Promise.resolve();
    const flight = tail.catch(() => {}).then(async () => {
      let accepted = false;
      try {
        // Dispatch 之前落盘running，独立服务崩溃后按unknown收口而不是重发native命令。
        await this.persist();
        receipt.result = await execute(); accepted = true; receipt.status = 'complete';
        await this.persist();
      }
      catch (error) {
        receipt.status = accepted || (error instanceof BridgeError && error.code === 'delivery-unknown') ? 'unknown' : 'failed';
        receipt.error = error instanceof BridgeError ? error.code : 'operation-failed';
        // 原生unknown以前只保存统一错误，丢失了helper的确定错误码；保留有界cause供只读诊断，绝不改变重放边界。
        const cause = error instanceof BridgeError ? nativeCauseCode(/** @type {BridgeError & {nativeCause?:unknown}} */ (error).nativeCause) : undefined;
        if (cause) receipt.nativeCause = cause;
        await this.persist().catch(() => {});
      }
      return receipt;
    }).finally(() => { if (this.tails.get(scope) === flight) this.tails.delete(scope); });
    this.commands.set(key, { digest: hash, receipt, flight });
    this.tails.set(scope, flight);
    return flight;
  }

  /** @param {string} scope @param {string} id */
  query(scope, id) { return this.commands.get(`${scope}:${id}`)?.receipt ?? null; }
}
