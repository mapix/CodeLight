import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const MAX_BODY = 128 * 1024;
const MAX_FRAME = 1024 * 1024;
const MAX_PENDING = 64;
/** @param {string} value */
const digest = (value) => createHash('sha256').update(value).digest();

/** @param {{port?:number,host?:string,token?:string,tls?:import('node:https').ServerOptions}} [options] */
export async function startRelay({ port = 9090, host = '127.0.0.1', token, tls } = {}) {
  if (typeof token !== 'string' || token.length < 40) throw Error('Provide a random connector token with at least 40 characters.');
  /** @type {WebSocket|null} */
  let connector = null;
  /** @type {Map<string,{response:import('node:http').ServerResponse,timer:ReturnType<typeof setTimeout>}>} */
  const pending = new Map();
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  /** @type {WeakMap<WebSocket,boolean>} */
  const alive = new WeakMap();
  const heartbeat = setInterval(() => {
    for (const socket of wsServer.clients) {
      if (alive.get(socket) === false) { socket.terminate(); continue; }
      alive.set(socket, false); socket.ping();
    }
  }, 15_000); heartbeat.unref();
  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  const handler = async (request, response) => {
    if (!connector || connector.readyState !== WebSocket.OPEN) { response.writeHead(503); response.end('Computer offline'); return; }
    if (pending.size >= MAX_PENDING) { response.writeHead(503); response.end('Too many requests'); return; }
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) { response.writeHead(413); response.end(); return; }
      chunks.push(chunk);
    }
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); response.destroy(); if (connector?.readyState === WebSocket.OPEN) connector.send(JSON.stringify({ type: 'cancel', id })); }, 12 * 60 * 60 * 1000);
    pending.set(id, { response, timer });
    response.on('close', () => { clearTimeout(timer); pending.delete(id); if (connector?.readyState === WebSocket.OPEN) connector.send(JSON.stringify({ type: 'cancel', id })); });
    connector.send(JSON.stringify({ type: 'request', id, method: request.method, path: request.url, headers: { cookie: request.headers.cookie, authorization: request.headers.authorization, origin: request.headers.origin, accept: request.headers.accept }, body: Buffer.concat(chunks).toString('base64') }));
  };
  const server = tls ? createTlsServer(tls, handler) : createServer(handler);
  server.on('upgrade', (request, socket, head) => {
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (request.url !== '/connector' || !timingSafeEqual(digest(supplied), digest(token))) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    if (connector?.readyState === WebSocket.OPEN) { socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      connector = ws;
      alive.set(ws, true); ws.on('pong', () => alive.set(ws, true));
      ws.on('message', (bytes) => {
        try {
          if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'backpressure'); return; }
          const frame = JSON.parse(bytes.toString());
          const job = pending.get(frame.id);
          if (!job) return;
          if (frame.type === 'start') {
            /** @type {Record<string,any>} */
            const allowed = {};
            for (const [key, value] of Object.entries(frame.headers ?? {})) if (['content-type', 'cache-control', 'set-cookie', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-accel-buffering'].includes(key.toLowerCase())) allowed[key] = value;
            job.response.writeHead(frame.status, allowed); job.response.flushHeaders();
          } else if (frame.type === 'chunk') {
            if (job.response.writableLength > 2 * 1024 * 1024) { job.response.destroy(); return; }
            job.response.write(Buffer.from(frame.body, 'base64'));
          } else if (frame.type === 'end') { clearTimeout(job.timer); pending.delete(frame.id); job.response.end(); }
          else if (frame.type === 'error') { clearTimeout(job.timer); pending.delete(frame.id); job.response.destroy(); }
        } catch { ws.close(1002, 'invalid-frame'); }
      });
      ws.on('close', () => {
        if (connector === ws) connector = null;
        for (const job of pending.values()) { clearTimeout(job.timer); job.response.destroy(); }
        pending.clear();
      });
      ws.on('error', () => {});
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(undefined)); });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('unexpected-relay-address');
  return { server, port: address.port, pending, close: async () => {
    clearInterval(heartbeat);
    connector?.terminate();
    await new Promise((resolve) => wsServer.close(() => resolve(undefined)));
    server.closeAllConnections(); await new Promise((resolve) => server.close(() => resolve(undefined)));
  } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const token = process.env.BRIDGE_RELAY_TOKEN ?? (process.env.BRIDGE_RELAY_TOKEN_FILE ? (await readFile(process.env.BRIDGE_RELAY_TOKEN_FILE, 'utf8')).trim() : '');
  const tls = process.env.BRIDGE_TLS_CERT && process.env.BRIDGE_TLS_KEY ? { cert: await readFile(process.env.BRIDGE_TLS_CERT), key: await readFile(process.env.BRIDGE_TLS_KEY) } : undefined;
  const relay = await startRelay({ port: Number(process.env.PORT ?? 9090), host: process.env.BRIDGE_LISTEN_HOST ?? '127.0.0.1', token, tls });
  process.stdout.write(`Agent Session Relay listening on port ${relay.port}\n`);
}
