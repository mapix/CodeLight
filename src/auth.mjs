import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { BridgeError } from './errors.mjs';
import { readFile } from 'node:fs/promises';
import { writePrivateJson } from './private-json.mjs';

/** @param {string} text */
const digest = (text) => createHash('sha256').update(text).digest();

export class PhoneAuth {
  /** @param {{now?: ()=>number, ttl?:number, maxAttempts?:number}} [options] */
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    this.ttl = options.ttl ?? 8 * 60 * 60 * 1000;
    this.maxAttempts = options.maxAttempts ?? 8;
    /** @type {Map<string, {hash:Buffer, expires:number}>} */
    this.sessions = new Map();
    /** @type {Map<string, {count:number, until:number}>} */
    this.attempts = new Map();
    this.pairCode = '';
    this.pairExpires = 0;
    this.rotatePairCode();
    /** @type {string|null} */
    this.storePath = null;
    this.storeTail = Promise.resolve();
  }

  /** @param {string} path */
  static async load(path) {
    const auth = new PhoneAuth(); auth.storePath = path;
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(data) || data.length > 64) throw Error('invalid-auth-store');
      for (const entry of data) if (typeof entry.id === 'string' && typeof entry.hash === 'string' && Number.isFinite(entry.expires) && entry.expires > auth.now()) {
        const hash = Buffer.from(entry.hash, 'base64');
        if (hash.length === 32) auth.sessions.set(entry.id, { hash, expires: entry.expires });
      }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw new BridgeError('auth-store-unavailable', '本机配对记录无法读取。', 503);
    }
    return auth;
  }

  persist() {
    if (!this.storePath) return Promise.resolve();
    const path = this.storePath;
    const operation = this.storeTail.then(() => writePrivateJson(path, [...this.sessions].filter(([, entry]) => entry.expires > this.now()).map(([id, entry]) => ({ id, hash: entry.hash.toString('base64'), expires: entry.expires }))));
    this.storeTail = operation.catch(() => {});
    return operation;
  }

  rotatePairCode() {
    this.pairCode = String(randomInt(10000000, 100000000));
    this.pairExpires = this.now() + 10 * 60 * 1000;
    return { code: this.pairCode, expiresAt: this.pairExpires };
  }

  /** @param {string} code @param {string} peer */
  pair(code, peer) {
    const previous = this.attempts.get(peer);
    if (previous && previous.until > this.now() && previous.count >= this.maxAttempts)
      throw new BridgeError('pair-rate-limited', '尝试次数过多，稍后重试。', 429);
    this.attempts.set(peer, { count: (previous?.until ?? 0) > this.now() ? (previous?.count ?? 0) + 1 : 1, until: this.now() + 60_000 });
    if (this.now() > this.pairExpires || !timingSafeEqual(digest(code), digest(this.pairCode)))
      throw new BridgeError('pair-denied', '配对码无效或已过期。', 401);
    const token = randomBytes(32).toString('base64url');
    const id = randomBytes(12).toString('base64url');
    this.sessions.set(id, { hash: digest(token), expires: this.now() + this.ttl });
    this.pairExpires = 0;
    return { id, cookie: `${id}.${token}` };
  }

  /** @param {string|undefined} cookie */
  authorize(cookie) {
    const value = cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith('bridge_session='))?.slice(15);
    const [id, token] = value?.split('.') ?? [];
    const session = id ? this.sessions.get(id) : undefined;
    if (!session || !token || session.expires < this.now() || !timingSafeEqual(digest(token), session.hash))
      throw new BridgeError('unauthorized', '请先在手机上配对。', 401);
    return id;
  }

  /** @param {string|undefined} credential */
  authorizeCredential(credential) {
    if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/.test(credential))
      throw new BridgeError('unauthorized', '原生设备凭据无效，请重新配对。', 401);
    return this.authorize(`bridge_session=${credential}`);
  }

  /** @param {string} id */
  revoke(id) { this.sessions.delete(id); }
}
