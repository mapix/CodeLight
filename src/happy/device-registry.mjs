import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readOptionalPrivateJson, writeDurablePrivateJson } from './discovery-persistence.mjs';

/** @typedef {Record<string,any>} Value */
export class DeviceRegistry extends EventEmitter {
  /** @param {string} path @param {Value[]} [rows] */
  constructor(path, rows = []) { super(); this.path = path; this.rows = rows; this.tail = Promise.resolve(); this.sockets = /** @type {Map<string,Set<import('node:net').Socket>>} */ (new Map()); }
  /** @param {string} path */
  static async load(path) { const saved = await readOptionalPrivateJson(path); return new DeviceRegistry(path, Array.isArray(saved?.devices) ? saved.devices : []); }
  list() { return this.rows.map(row => ({ id: row.id, name: row.name, createdAt: row.createdAt, lastSeen: row.lastSeen, revoked: row.revoked,
    connected: (this.sockets.get(row.id)?.size ?? 0) > 0, notifications: !row.revoked && row.push?.enabled === true })).sort((a, b) => b.lastSeen - a.lastSeen); }
  notificationDevices() { return this.rows.filter(row => !row.revoked && row.push?.enabled && row.push?.token); }
  /** Current foreground interests are ephemeral Happy IDs, not original runtime state.
   * @param {number} [now] @returns {Set<string>} */
  viewedSessions(now = Date.now()) {
    const sessions = new Set();
    for (const row of this.rows) {
      const presence = row.presence, age = now - presence?.at;
      if (!row.revoked && (this.sockets.get(row.id)?.size ?? 0) > 0 && presence?.active === true &&
        typeof presence.sessionId === 'string' && presence.sessionId.trim() && Number.isFinite(age) && age >= 0 && age <= 45000) sessions.add(presence.sessionId);
    }
    return sessions;
  }
  /** @param {string} id @param {Value} value */
  async registerPush(id, value) {
    const row = this.rows.find(row => row.id === id && !row.revoked); if (!row) throw Error('unknown-device');
    if (value.enabled !== true) { row.push = { enabled: false }; await this.save(); return; }
    if (!/^[a-f0-9]{64,200}$/iu.test(value.token ?? '') || !['development', 'production'].includes(value.environment)) throw Error('invalid-push-registration');
    row.push = { enabled: true, token: value.token, environment: value.environment }; await this.save();
  }
  /** @param {string} id */
  async disablePush(id) { const row = this.rows.find(row => row.id === id); if (row) { row.push = { enabled: false }; await this.save(); } }
  /** @param {string} id @param {Value} value */
  viewingPresence(id, value) {
    const row = this.rows.find(row => row.id === id && !row.revoked); if (!row || typeof value.active !== 'boolean' || value.sessionId !== null && (typeof value.sessionId !== 'string' || value.sessionId.length > 128)) throw Error('invalid-viewing-presence');
    row.presence = { active: value.active, sessionId: value.sessionId, at: Date.now() };
  }
  async save() { const snapshot = structuredClone(this.rows); const operation = this.tail.catch(() => {}).then(() => writeDurablePrivateJson(this.path, { version: 1, devices: snapshot })); this.tail = operation; await operation; this.emit('changed', this.list()); }
  /** @param {string} publicKey @param {string} name @param {string} token @param {number} [issuedAt] */
  async approve(publicKey, name, token, issuedAt = Date.now()) {
    const id = createHash('sha256').update(publicKey).digest('hex').slice(0, 24), now = Date.now();
    let row = this.rows.find(row => row.id === id);
    if (row?.revokedAt && issuedAt <= row.revokedAt) throw Error('new-pairing-invitation-required');
    if (!row) { row = { id, publicKey, name: name.slice(0, 80) || 'Phone', createdAt: now, lastSeen: now }; this.rows.push(row); }
    const hash = createHash('sha256').update(token).digest('hex');
    if (row.tokenHash && row.tokenHash !== hash) for (const socket of this.sockets.get(id) ?? []) socket.destroy();
    row.tokenHash = hash; row.revoked = false; row.lastSeen = now;
    await this.save(); return id;
  }
  /** @param {unknown} token */
  authorize(token) {
    if (typeof token !== 'string' || !token) return null;
    const digest = createHash('sha256').update(token).digest('hex'), row = this.rows.find(row => row.tokenHash === digest && !row.revoked);
    if (!row) return null;
    if (Date.now() - row.lastSeen > 10000) { row.lastSeen = Date.now(); this.save().catch(() => {}); }
    return row.id;
  }
  /** @param {string} id @param {string} name */
  async rename(id, name) { const row = this.rows.find(row => row.id === id); if (!row || !name.trim() || name.length > 80) throw Error('invalid-device-name'); row.name = name.trim(); await this.save(); }
  /** @param {string} id */
  async revoke(id) {
    const row = this.rows.find(row => row.id === id); if (!row) throw Error('unknown-device');
    // 先持久化撤销，再断开该设备已有连接；其他设备与原 Codex owner 不受影响。
    row.revoked = true; row.revokedAt = Date.now(); await this.save();
    for (const socket of this.sockets.get(id) ?? []) socket.destroy(); this.sockets.delete(id); this.emit('changed', this.list());
  }
  /** @param {string} id @param {import('node:net').Socket} socket */
  connected(id, socket) {
    let sockets = this.sockets.get(id); if (!sockets) { sockets = new Set(); this.sockets.set(id, sockets); }
    sockets.add(socket); this.emit('changed', this.list());
    socket.once('close', () => { this.sockets.get(id)?.delete(socket); this.emit('changed', this.list()); });
  }
}
