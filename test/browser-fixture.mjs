import { startBridge } from '../src/server.mjs';
import { SessionStorage } from '../src/storage.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

class FixtureStorage extends SessionStorage {
  /** @param {'codex'|'zcode'} app */
  async list(app) { return [{ app, id: 'fixture_session', title: '手机界面验证 · 专用样本', workspace: '/fixture', updatedAt: Date.now() }]; }
  /** @param {import('../src/address.mjs').SessionAddress} address */
  async snapshot(address) { return { app: address.app, session: { id: address.id }, items: [], live: false }; }
}

/** @type {Record<string,any>} */
let view = { rows: [{ id: 'intro', role: 'assistant', text: '这是专用界面验证样本，不连接真实桌面应用。', tools: [] }], currentTurnId: null, status: 'idle', revision: 1, requests: [] };
/** @type {Set<(view:Record<string,any>)=>void>} */
const listeners = new Set();
/** @type {Record<string,any>[]} */
const actions = [];
const publish = () => { view.revision++; for (const listener of listeners) listener(structuredClone(view)); };
const fixture = {
  async status() { return { connected: true, mode: 'fixture' }; },
  /** @param {string} _id */
  async snapshot(_id) { return structuredClone(view); },
  /** @param {string} _id @param {(view:Record<string,any>)=>void} onView */
  async subscribe(_id, onView) { listeners.add(onView); onView(structuredClone(view)); return () => { listeners.delete(onView); }; },
  /** @param {string} id @param {string} action @param {Record<string,any>} payload @param {string} commandId */
  async command(id, action, payload, commandId) {
    if (id !== 'fixture_session') throw Error('fixture-boundary');
    actions.push({ action, payload, commandId });
    if (action === 'send') {
      view.rows.push({ id: commandId, role: 'user', text: payload.text, tools: [] });
      view.currentTurnId = 'fixture_turn'; view.status = 'active';
      view.requests = [{ requestId: 'fixture_question', kind: 'user-input', operable: true, questions: [{ id: 'verify_mode', question: '选择本次验证方式', other: false, secret: false, options: [{ label: '只读验证' }, { label: '完整验证' }] }] }];
      publish();
    } else if (action === 'approval') {
      if (payload.response.answers.verify_mode.answers[0] !== '只读验证') throw Error('unexpected-fixture-answer');
      view.requests = []; view.rows.push({ id: 'fixture_answer', role: 'assistant', text: '已收到只读验证选择。', tools: [] }); publish();
    } else if (action === 'interrupt') { view.currentTurnId = null; view.status = 'idle'; publish(); }
    return { action, acknowledged: true };
  }
};

const bridge = await startBridge({ port: 0, storage: new FixtureStorage(), adapters: { codex: fixture } });
const directory = fileURLToPath(new URL('../evidence/private/', import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(`${directory}browser-fixture.json`, JSON.stringify({ port: bridge.port, pairCode: bridge.auth.pairCode, instanceId: bridge.instanceId, pid: process.pid }), { mode: 0o600 });
process.stdout.write(JSON.stringify({ fixturePort: bridge.port, pid: process.pid }) + '\n');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void writeFile(`${directory}browser-fixture-actions.json`, JSON.stringify(actions), { mode: 0o600 }).then(() => bridge.close()).then(() => process.exit(0)); });
