import { BridgeError } from './errors.mjs';

/** @typedef {{ app: 'codex'|'zcode', id: string }} SessionAddress */
/** @param {unknown} value @returns {SessionAddress} */
export function parseAddress(value) {
  if (!value || typeof value !== 'object') throw new BridgeError('invalid-address', '请选择会话。');
  const candidate = /** @type {{app?: unknown, id?: unknown}} */ (value);
  if (candidate.app !== 'codex' && candidate.app !== 'zcode') throw new BridgeError('invalid-app', '应用不存在。');
  if (typeof candidate.id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(candidate.id)) throw new BridgeError('invalid-session', '会话地址无效。');
  return { app: candidate.app, id: candidate.id };
}

/** @param {SessionAddress} address */
export function addressKey(address) { return `${address.app}:${address.id}`; }
