import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BridgeError } from './errors.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./storage.py', import.meta.url));

export class SessionStorage {
  /** @param {{codex?:string,zcode?:string,python?:string}} [options] */
  constructor(options = {}) {
    this.roots = { codex: options.codex ?? `${homedir()}/.codex`, zcode: options.zcode ?? `${homedir()}/.zcode` };
    this.python = options.python ?? '/usr/bin/python3';
  }

  /** @param {'codex'|'zcode'} app @param {'list'|'snapshot'} action @param {string[]} [extra] */
  async read(app, action, extra = []) {
    try {
      const { stdout } = await execute(this.python, [script, action, '--app', app, '--root', this.roots[app], ...extra], { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 });
      const response = /** @type {{ok:boolean,error?:string,result?:unknown}} */ (JSON.parse(stdout));
      if (!response.ok) throw new BridgeError(response.error ?? 'session-store-unavailable', '无法读取这个应用的会话记录。', 503);
      return response.result;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('session-store-unavailable', '无法读取这个应用的会话记录。', 503);
    }
  }

  /** @param {'codex'|'zcode'} app @param {number} [offset] */
  list(app, offset = 0) { return this.read(app, 'list', ['--offset', String(offset)]); }
  /** @param {import('./address.mjs').SessionAddress} address */
  snapshot(address) { return this.read(address.app, 'snapshot', ['--id', address.id, '--limit', '200']); }
}
