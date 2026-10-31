import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

/** @param {{relayUrl:string,localUrl:string,token:string}} options */
export async function startConnector({ relayUrl, localUrl, token }) {
  const relay = new URL(relayUrl);
  if (relay.protocol !== 'wss:' && !(relay.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(relay.hostname))) throw Error('Remote relay requires WSS.');
  const local = new URL(localUrl);
  if (local.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)) throw Error('Connector upstream must be a local HTTP bridge.');
  relay.pathname = '/connector'; relay.search = ''; relay.hash = '';
  /** @type {Map<string,import('node:http').ClientRequest>} */
  const jobs = new Map();
  const socket = new WebSocket(relay, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 10_000 });
  let alive = true;
  socket.on('pong', () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!alive) { socket.terminate(); return; }
    alive = false; socket.ping();
  }, 15_000); heartbeat.unref();
  /** @param {Record<string,unknown>} frame */
  const send = (frame) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, 'backpressure'); return false; }
    socket.send(JSON.stringify(frame)); return true;
  };
  socket.on('message', (bytes) => {
    try {
      const frame = JSON.parse(bytes.toString());
      if (frame.type === 'cancel') { jobs.get(frame.id)?.destroy(); jobs.delete(frame.id); return; }
      if (frame.type !== 'request' || typeof frame.id !== 'string' || jobs.has(frame.id) || jobs.size >= 64 || !['GET', 'POST'].includes(frame.method) || typeof frame.path !== 'string' || !frame.path.startsWith('/') || frame.path.startsWith('//')) throw Error('invalid-request');
      const body = Buffer.from(frame.body ?? '', 'base64'); if (body.length > 128 * 1024) throw Error('invalid-body');
      const headers = { host: local.host, cookie: frame.headers?.cookie ?? '', authorization: frame.headers?.authorization ?? '', origin: frame.headers?.origin ?? '', accept: frame.headers?.accept ?? '', 'content-type': 'application/json', 'content-length': body.length };
      const request = httpRequest({ hostname: local.hostname, port: local.port, path: frame.path, method: frame.method, headers }, (response) => {
        if (!send({ type: 'start', id: frame.id, status: response.statusCode, headers: response.headers })) { response.destroy(); return; }
        response.on('data', (chunk) => { if (!send({ type: 'chunk', id: frame.id, body: chunk.toString('base64') })) response.destroy(); });
        response.on('end', () => { send({ type: 'end', id: frame.id }); jobs.delete(frame.id); });
        response.on('error', () => { send({ type: 'error', id: frame.id }); jobs.delete(frame.id); });
      });
      jobs.set(frame.id, request);
      request.on('error', () => { send({ type: 'error', id: frame.id }); jobs.delete(frame.id); });
      request.end(body);
    } catch { socket.close(1002, 'invalid-frame'); }
  });
  socket.on('close', () => { clearInterval(heartbeat); for (const job of jobs.values()) job.destroy(); jobs.clear(); });
  await new Promise((resolve, reject) => { socket.once('open', () => resolve(undefined)); socket.once('error', reject); });
  socket.on('error', () => {});
  return { socket, jobs, close: () => socket.terminate() };
}

/** @param {{relayUrl:string,localUrl:string,token:string,minBackoffMs?:number,maxBackoffMs?:number,onStatus?:(status:string)=>void}} options */
export function manageConnector(options) {
  let stopped = false;
  /** @type {Awaited<ReturnType<typeof startConnector>>|null} */
  let current = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {(()=>void)|null} */
  let wake = null;
  const notify = options.onStatus ?? (() => {});
  const min = options.minBackoffMs ?? 500, max = options.maxBackoffMs ?? 10_000;
  const done = (async () => {
    let backoff = min;
    while (!stopped) {
      try {
        notify('connecting'); current = await startConnector(options);
        if (stopped) { current.close(); break; }
        notify('connected'); backoff = min;
        // 只恢复传输连接；断开的HTTP业务写请求绝不进入重放队列。
        await new Promise((resolve) => current?.socket.once('close', () => resolve(undefined)));
      } catch { if (!stopped) notify('unavailable'); }
      current = null;
      if (stopped) break;
      notify('reconnecting');
      await new Promise((resolve) => { wake = () => resolve(undefined); timer = setTimeout(wake, backoff); });
      timer = null; wake = null; backoff = Math.min(max, backoff * 2);
    }
    notify('stopped');
  })();
  return { done, close: async () => { stopped = true; current?.close(); if (timer) clearTimeout(timer); wake?.(); await done; } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const token = process.env.BRIDGE_RELAY_TOKEN ?? (process.env.BRIDGE_RELAY_TOKEN_FILE ? (await readFile(process.env.BRIDGE_RELAY_TOKEN_FILE, 'utf8')).trim() : '');
  if (!process.env.BRIDGE_RELAY_URL) throw Error('Set BRIDGE_RELAY_URL.');
  const manager = manageConnector({ relayUrl: process.env.BRIDGE_RELAY_URL, localUrl: process.env.BRIDGE_LOCAL_URL ?? 'http://127.0.0.1:9089', token,
    onStatus: (status) => process.stdout.write(`Relay connector: ${status}\n`) });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void manager.close(); });
  await manager.done;
}
