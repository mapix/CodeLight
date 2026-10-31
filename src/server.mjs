import { createServer } from 'node:http';
import { networkInterfaces, homedir } from 'node:os';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PhoneAuth } from './auth.mjs';
import { parseAddress, addressKey } from './address.mjs';
import { CommandReceipts } from './commands.mjs';
import { SessionStorage } from './storage.mjs';
import { BridgeError, publicError } from './errors.mjs';
import { readJson, json, verifyOrigin, event } from './http.mjs';
import { CodexBackend } from './adapters/codex-backend.mjs';
import { ZCodeAxBackend } from './adapters/zcode-ax.mjs';
import { WindowFrames } from './window-frames.mjs';

/** @typedef {{ status:()=>Promise<Record<string,unknown>>, list?:()=>Promise<unknown>, snapshot:(id:string)=>Promise<any>, subscribe:(id:string,onFrame:(frame:any)=>void)=>Promise<()=>void>, command:(id:string,action:string,payload:any,commandId:string)=>Promise<unknown>,dispose?:()=>void|Promise<void> }} DesktopAdapter */

const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/requests.js', ['requests.js', 'text/javascript; charset=utf-8']], ['/form-fields.js', ['form-fields.js', 'text/javascript; charset=utf-8']], ['/window.js', ['window.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);

/** @param {{port?:number,lan?:boolean,relayOrigin?:string,adminToken?:string,storage?:SessionStorage,adapters?:Partial<Record<'codex'|'zcode',DesktopAdapter>>,auth?:PhoneAuth,receipts?:CommandReceipts,subscribeRetryMs?:number}} [options] */
export async function startBridge(options = {}) {
  const storage = options.storage ?? new SessionStorage();
  const auth = options.auth ?? new PhoneAuth();
  const receipts = options.receipts ?? new CommandReceipts();
  const instanceId = randomUUID();
  const adminToken = options.adminToken ?? randomBytes(32).toString('hex');
  /** @type {Partial<Record<'codex'|'zcode',DesktopAdapter>>} */
  const adapters = options.adapters ?? { codex: new CodexBackend(), zcode: new ZCodeAxBackend() };
  const frameDirectory = /** @type {ZCodeAxBackend|undefined} */ (adapters.zcode)?.screenshotDir ?? fileURLToPath(new URL('../data/zcode-window-images', import.meta.url));
  const frames = new WindowFrames(frameDirectory);
  const hosts = new Set();
  const addresses = ['127.0.0.1', 'localhost'];
  for (const records of Object.values(networkInterfaces())) for (const record of records ?? []) {
    if (record.family === 'IPv4' && !record.internal) addresses.push(record.address);
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined;
      const nativePhone = bearer ? auth.authorizeCredential(bearer) : null;
      const nativePair = request.method === 'POST' && url.pathname === '/api/native/pair' && !request.headers.origin;
      verifyOrigin(request, hosts, options.relayOrigin, nativePhone !== null || nativePair);
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [filename, type] = /** @type {[string,string]} */ (assets.get(url.pathname));
        const body = await readFile(new URL(`../public/${filename}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
        response.end(body); return;
      }
      if (request.method === 'GET' && url.pathname === '/healthz') {
        json(response, 200, { service: 'agent-session-bridge', instanceId }); return;
      }
      if (request.method === 'POST' && url.pathname === '/admin/pair-code') {
        const supplied = request.headers['x-bridge-admin'];
        const expected = Buffer.from(adminToken);
        const token = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') || token.length !== expected.length || !timingSafeEqual(token, expected))
          throw new BridgeError('unauthorized', '本机管理凭据无效。', 401);
        json(response, 200, auth.rotatePairCode()); return;
      }
      if (request.method === 'POST' && (url.pathname === '/api/pair' || url.pathname === '/api/native/pair')) {
        const body = await readJson(request, 1024);
        if (typeof body.code !== 'string') throw new BridgeError('invalid-pair-code', '请输入配对码。');
        const session = auth.pair(body.code, request.socket.remoteAddress ?? 'unknown');
        try { await auth.persist(); } catch { auth.revoke(session.id); throw new BridgeError('pair-store-unavailable', '配对记录保存失败，请稍后重试。', 503); }
        if (url.pathname === '/api/native/pair') json(response, 200, { credential: session.cookie, instanceId });
        else {
          response.setHeader('Set-Cookie', `bridge_session=${session.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${options.relayOrigin?.startsWith('https:') ? '; Secure' : ''}`);
          json(response, 200, { paired: true });
        }
        return;
      }
      const phone = nativePhone ?? auth.authorize(request.headers.cookie);
      if (request.method === 'POST' && (url.pathname === '/api/logout' || url.pathname === '/api/native/logout')) {
        auth.revoke(phone); await auth.persist(); response.setHeader('Set-Cookie', 'bridge_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        json(response, 200, {}); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        const states = await Promise.all(['codex', 'zcode'].map(async (name) => {
          const app = /** @type {'codex'|'zcode'} */ (name);
          try { return { app, ...(adapters[app] ? await adapters[app].status() : { connected: false, reason: 'control-unavailable' }) }; }
          catch { return { app, connected: false, reason: 'connection-failed' }; }
        }));
        json(response, 200, { instanceId, apps: states }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        const app = url.searchParams.get('app');
        if (app !== 'codex' && app !== 'zcode') throw new BridgeError('invalid-app', '请选择应用。');
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new BridgeError('invalid-offset', '分页地址无效。');
        const adapter = adapters[app];
        json(response, 200, { app, sessions: adapter?.list ? await adapter.list() : await storage.list(app, offset) }); return;
      }
      const address = parseAddress({ app: url.searchParams.get('app'), id: url.searchParams.get('id') });
      if (request.method === 'GET' && url.pathname === '/api/window-image') {
        const image = await frames.read(address, url.searchParams.get('frame') ?? '');
        response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(image); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/snapshot') {
        const adapter = adapters[address.app];
        const persisted = adapter?.list ? null : await storage.snapshot(address);
        let native = null;
        let nativeUnavailable = null;
        if (adapter) { try { native = await frames.publish(address, await adapter.snapshot(address.id)); } catch (error) { if (adapter.list) throw error; nativeUnavailable = publicError(error); /* Persisted history is explicitly labelled, never reported as live. */ } }
        else nativeUnavailable = { error: 'control-unavailable', message: '当前无法连接原桌面会话。', status: 503 };
        json(response, 200, { address, persisted, native, nativeUnavailable, live: native !== null }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
        const adapter = adapters[address.app];
        let disposed = false;
        let release = () => {};
        let generation = 0, attempts = 0;
        /** @type {ReturnType<typeof setTimeout>|null} */
        let retry = null;
        const cleanup = () => { disposed = true; generation++; clearInterval(heartbeat); if (retry) clearTimeout(retry); release(); };
        response.on('close', cleanup);
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15_000);
        if (!adapter) event(response, 'unavailable', { reason: 'control-unavailable' });
        else {
          const attach = async () => {
          const current = ++generation;
          try {
            let publishFlight = Promise.resolve();
            const detached = await adapter.subscribe(address.id, (frame) => {
              publishFlight = publishFlight.then(async () => {
                if (disposed || current !== generation) return;
                const published = await frames.publish(address, frame);
                if (!disposed && current === generation) event(response, 'native', { address, frame: published });
              }).catch(() => { if (!disposed && current === generation) event(response, 'unavailable', { reason: 'window-frame-unavailable' }); });
            });
            if (disposed || current !== generation) detached();
            else { release = detached; attempts = 0; }
          } catch (error) {
            if (!disposed && current === generation) {
              event(response, 'unavailable', { reason: publicError(error).error });
              const delay = Math.min(10_000, (options.subscribeRetryMs ?? 1000) * 2 ** Math.min(attempts++, 4));
              retry = setTimeout(() => { retry = null; void attach(); }, delay);
            }
          }
          };
          void attach();
        }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/receipt') {
        const receipt = receipts.query(`${phone}:${addressKey(address)}`, url.searchParams.get('commandId') ?? '');
        json(response, 200, { receipt, instanceId }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/command') {
        const body = await readJson(request);
        if (body.instanceId !== instanceId) throw new BridgeError('bridge-restarted', '服务已重启，请先确认原操作结果。', 409);
        const adapter = adapters[address.app];
        if (!adapter) throw new BridgeError('control-unavailable', '当前无法控制这个应用。', 503);
        const actions = address.app === 'zcode' ? ['launch', 'activate', 'enableAccessibility', 'press', 'click', 'type', 'key', 'scroll'] : ['send', 'steer', 'interrupt', 'approval', 'answer-question', 'open-desktop'];
        if (!actions.includes(body.action)) throw new BridgeError('invalid-action', '操作不存在。');
        if (typeof body.commandId !== 'string') throw new BridgeError('invalid-command-id', '操作编号无效。');
        const result = await receipts.run(`${phone}:${addressKey(address)}`, body.commandId, { action: body.action, payload: body.payload }, () => adapter.command(address.id, body.action, body.payload, body.commandId));
        json(response, 200, { receipt: result, instanceId }); return;
      }
      throw new BridgeError('not-found', '地址不存在。', 404);
    } catch (error) {
      const failure = publicError(error);
      if (response.headersSent) { event(response, 'error', failure); response.end(); }
      else json(response, failure.status, failure);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 9089, options.lan ? '0.0.0.0' : '127.0.0.1', () => resolve(undefined)); });
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw Error('unexpected-server-address');
  for (const address of addresses) hosts.add(`${address}:${bound.port}`);
  return { server, port: bound.port, addresses, auth, instanceId, adminToken, close: async () => {
    server.closeAllConnections();
    await Promise.all(Object.values(adapters).map((adapter) => adapter?.dispose?.()));
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
  } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Use Node.js 24 or newer.');
  const bridge = await startBridge({ lan: process.argv.includes('--lan'), relayOrigin: process.env.BRIDGE_PUBLIC_ORIGIN });
  const directory = join(homedir(), '.agent-session-bridge');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ pid: process.pid, port: bridge.port, instanceId: bridge.instanceId, startedAt: Date.now() }), { mode: 0o600 });
  process.stdout.write(`Agent Session Bridge: http://localhost:${bridge.port}\n一次性配对码：${bridge.auth.pairCode}\n`);
  if (process.argv.includes('--lan')) for (const address of bridge.addresses.filter((item) => item !== 'localhost' && item !== '127.0.0.1')) process.stdout.write(`手机地址：http://${address}:${bridge.port}\n`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void bridge.close().then(() => process.exit(0)); });
}
