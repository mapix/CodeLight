import { createHash } from 'node:crypto';
import { readOptionalPrivateJson, writeDurablePrivateJson } from './discovery-persistence.mjs';
/** @typedef {Record<string,any>} Value */
/** Only identities and statuses enter the push journal. @param {Value} view @param {Value[]} requests */
export function notificationSummary(view, requests) {
  const turns = /** @type {Record<string,string>} */ ({});
  for (const row of view.rows ?? []) if (row.turnId && ['completed', 'complete', 'stop', 'failed', 'error'].includes(row.status)) turns[row.turnId] = ['failed', 'error'].includes(row.status) ? 'failed' : 'completed';
  return { currentTurnId: typeof view.currentTurnId === 'string' ? view.currentTurnId : null, turns, requests: requests.map(r => r.key).filter((/** @type {unknown} */ key) => typeof key === 'string') };
}
/** @param {Value|null} previous @param {Value} next @returns {{identity:string,kind:string}[]} */
export function actionableTransitions(previous, next) {
  if (!previous) return [];
  const events = [];
  // 首次出现的历史终态不是新完成事件；需要先观察到该原 turn 正在运行。
  for (const [id, status] of Object.entries(next.turns)) if (id !== next.currentTurnId && id === previous.currentTurnId) events.push({ identity: `turn:${id}:${status}`, kind: /** @type {string} */ (status) });
  for (const id of next.requests) if (!previous.requests.includes(id)) events.push({ identity: `request:${id}`, kind: 'input' });
  return events;
}
export class NotificationDispatcher {
  /** @param {{path:string,devices:import('./device-registry.mjs').DeviceRegistry,sender:Value|null,origin:()=>string,onDiagnostic?:(code:string)=>void}} options */
  constructor(options) { this.options = options; this.pending = /** @type {Value[]} */ ([]); this.delivered = /** @type {string[]} */ ([]); this.baselines = /** @type {Map<string,Value>} */ (new Map()); this.tail = Promise.resolve(); this.closed = false; }
  async start() {
    const saved = await readOptionalPrivateJson(this.options.path); this.pending = saved?.pending ?? []; this.delivered = saved?.delivered ?? [];
    this.timer = setInterval(() => { this.enqueue(() => this.drain()).catch(() => {}); }, 30000); this.timer.unref(); await this.enqueue(() => this.drain());
  }
  /** @param {()=>Promise<void>} run */
  enqueue(run) { const flight = this.tail.catch(() => {}).then(run); this.tail = flight; return flight; }
  save() { return writeDurablePrivateJson(this.options.path, { version: 1, pending: this.pending, delivered: this.delivered.slice(-4096) }); }
  /** @param {string} sourceKey @param {string} sessionId @param {Value} summary */
  observe(sourceKey, sessionId, summary) {
    return this.enqueue(async () => {
      if (this.closed) return;
      const saved = this.baselines.get(sourceKey); const previous = saved?.epoch === summary.epoch ? saved ?? null : null; this.baselines.set(sourceKey, summary);
      if (!this.options.sender) return;
      const now = Date.now();
      for (const transition of actionableTransitions(previous, summary)) {
        const id = createHash('sha256').update(JSON.stringify([sourceKey, transition.identity])).digest('hex');
        for (const device of this.options.devices.notificationDevices()) {
          const deliveryId = id + ':' + device.id;
          if (this.delivered.includes(deliveryId) || this.pending.some(p => p.deliveryId === deliveryId)) continue;
          if (device.presence?.active && device.presence.sessionId === sessionId && now - device.presence.at < 45000) { this.delivered.push(deliveryId); continue; }
          this.pending.push({ id, deliveryId, deviceId: device.id, sessionId, kind: transition.kind, origin: this.options.origin(), createdAt: now, attempts: 0 });
        }
      }
      await this.save(); await this.drain();
    });
  }
  async drain() {
    if (this.closed || !this.options.sender) return;
    for (const event of [...this.pending]) {
      const device = this.options.devices.notificationDevices().find(d => d.id === event.deviceId);
      if (!device || device.push.environment !== this.options.sender.environment || Date.now() - event.createdAt > 3600000 || event.attempts >= 3) { this.pending = this.pending.filter(p => p !== event); continue; }
      if (device.presence?.active && device.presence.sessionId === event.sessionId && Date.now() - device.presence.at < 45000) { this.pending = this.pending.filter(p => p !== event); this.delivered.push(event.deliveryId); continue; }
      event.attempts++; await this.save();
      try {
        // 发送前再次验证设备授权，撤销操作不会复用旧设备 token。
        if (!this.options.devices.notificationDevices().some(d => d.id === event.deviceId)) continue;
        const result = await this.options.sender.send(device.push.token, event);
        if (result.invalidToken) await this.options.devices.disablePush(device.id);
        if (result.ok || !result.retry) { this.pending = this.pending.filter(p => p !== event); this.delivered.push(event.deliveryId); }
        if (!result.ok) this.options.onDiagnostic?.('apns-delivery-pending');
      } catch { this.options.onDiagnostic?.('apns-delivery-pending'); }
      await this.save();
    }
    this.delivered = this.delivered.slice(-4096); await this.save();
  }
  async close() { this.closed = true; if (this.timer) clearInterval(this.timer); await this.tail.catch(() => {}); }
}
