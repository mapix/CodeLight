import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import nacl from 'tweetnacl';
import { RelayChannel, FRAME_BYTES, streamId, safePath, safeHeaders } from './relay-protocol.mjs';

/** @typedef {Record<string,any>} Value */
export function relayIdentity(/** @type {Uint8Array} */ publicKey) { return createHash('sha256').update(publicKey).digest('hex').slice(0, 24); }
export function registrationMessage(/** @type {string} */ challenge) { return Buffer.from('CodeLight network relay v1\n' + challenge); }
/** @param {unknown} value @param {number} size */
function keyBytes(value, size) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw Error('invalid-network-key');
  const bytes = Buffer.from(value, 'base64url'); if (bytes.length !== size || bytes.toString('base64url') !== value) throw Error('invalid-network-key'); return bytes;
}

/** Public network forwarding only; no account/session store or arbitrary dial target.
 * @param {{token:string}} options */
export function createNetworkRelay(options) {
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(options.token ?? '')) throw Error('A high-entropy REGISTRATION_TOKEN is required.');
  const digest = createHash('sha256').update(options.token).digest();
  const bindings = /** @type {Map<string,Value>} */ (new Map()), active = new Set();
  const authorize = (/** @type {unknown} */ header) => typeof header === 'string' && header.startsWith('Bearer ') && header.length < 512 && timingSafeEqual(digest, createHash('sha256').update(header.slice(7)).digest());
  const wss = new WebSocketServer({ noServer: true, maxPayload: FRAME_BYTES + 17, perMessageDeflate: false });
  const route = (/** @type {string|undefined} */ url) => {
    const matched = url?.match(/^\/r\/([a-f0-9]{24})(\/.*)$/u); if (!matched) return null;
    return { binding: bindings.get(matched[1]), path: safePath(matched[2]) };
  };
  /** @param {Value} binding @param {string} id @param {Value} options */
  function reserve(binding, id, options) {
    if (active.size >= 512) throw Error('relay-stream-budget');
    const key = binding.id + ':' + id;
    const stream = binding.channel.add(id, { ...options, onAbort: () => { active.delete(key); options.onAbort?.(); } });
    active.add(key);
    stream.retire = () => { active.delete(key); binding.channel.send({ type: 'complete', id }); binding.channel.done(id); };
    return stream;
  }
  const server = createServer({ headersTimeout: 10000, requestTimeout: 60000, keepAliveTimeout: 5000 }, (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') { res.end('ok\n'); return; }
    if (req.method === 'GET' && req.url === '/relay/v1/info') {
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ service: 'codelight-network-relay', version: 1, http: true, websocket: true, requiresToken: true })); return;
    }
    try {
      const target = route(req.url);
      if (!target?.binding || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method ?? '')) { res.writeHead(503).end('Public Mac entry unavailable'); return; }
      const id = streamId(), binding = target.binding;
      const stream = reserve(binding, id, { writable: res, bodyLimit: 64 * 1024 * 1024, onAbort: () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); } });
      stream.timer = setTimeout(() => binding.channel.drop(id), 60000); stream.timer.unref();
      res.once('finish', stream.retire); res.once('close', () => { if (!res.writableFinished) binding.channel.drop(id); });
      req.once('aborted', () => binding.channel.drop(id));
      binding.channel.send({ type: 'http-open', id, method: req.method, path: target.path, headers: safeHeaders(req.headers) });
      binding.channel.pipe(stream, req);
    } catch { if (!res.headersSent) res.writeHead(400).end(); else res.destroy(); }
  });
  server.maxConnections = 512;
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/relay/v1/tunnel') {
      if (!authorize(req.headers.authorization) || wss.clients.size >= 40) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        const connection = /** @type {Value} */ ({ socket: ws, id: null, publicKey: null, challenge: randomBytes(32).toString('base64url'), alive: true });
        const timeout = setTimeout(() => ws.close(1008, 'registration-timeout'), 10000); timeout.unref();
        connection.channel = new RelayChannel(ws, value => {
          if (!connection.id) {
            if (value.type !== 'register' || value.challenge !== connection.challenge) throw Error('invalid-registration');
            const publicKey = keyBytes(value.publicKey, 32), signature = keyBytes(value.signature, 64);
            if (!nacl.sign.detached.verify(registrationMessage(connection.challenge), signature, publicKey)) throw Error('invalid-registration');
            const id = relayIdentity(publicKey), previous = bindings.get(id);
            if (!previous && bindings.size >= 32 || previous && previous.publicKey !== value.publicKey) throw Error('binding-budget');
            clearTimeout(timeout); connection.id = id; connection.publicKey = value.publicKey; connection.challenge = null;
            bindings.set(id, connection);
            // 旧连接晚到的 close 不能抹掉已经认证的新绑定。
            previous?.socket.close(1000, 'authenticated-handover');
            connection.channel.send({ type: 'registered', version: 1, id, publicPath: '/r/' + id }); return;
          }
          const stream = connection.channel.streams.get(value.id); if (!stream) return;
          if (!['http-head', 'upgrade-head'].includes(value.type) || !Number.isSafeInteger(value.status) || value.status < 100 || value.status > 599) throw Error('invalid-forward-response');
          const headers = safeHeaders(value.headers, value.type === 'upgrade-head' && value.status === 101);
          if (value.type === 'http-head') { if (stream.head) throw Error('duplicate-head'); stream.head = true; stream.writable.writeHead(value.status, headers); }
          else {
            if (stream.head) throw Error('duplicate-head'); stream.head = true; stream.writable = stream.clientSocket;
            const lines = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(v => `${name}: ${v}`));
            stream.clientSocket.write(`HTTP/1.1 ${value.status} ${value.status === 101 ? 'Switching Protocols' : 'Relay response'}\r\n${lines.join('\r\n')}\r\n\r\n`);
            connection.channel.pipe(stream, stream.clientSocket, stream.initialHead);
          }
        });
        ws.on('pong', () => { connection.alive = true; });
        ws.once('close', () => { clearTimeout(timeout); if (connection.id && bindings.get(connection.id) === connection) bindings.delete(connection.id); });
        connection.channel.send({ type: 'challenge', version: 1, challenge: connection.challenge });
      }); return;
    }
    try {
      const target = route(req.url);
      if (!target?.binding || req.headers.upgrade?.toLowerCase() !== 'websocket') throw Error('unavailable-upgrade');
      socket.pause(); const id = streamId(), binding = target.binding;
      const stream = reserve(binding, id, { clientSocket: socket, initialHead: head, onAbort: () => socket.destroy() });
      socket.once('close', () => binding.channel.drop(id)); socket.on('error', () => binding.channel.drop(id));
      binding.channel.send({ type: 'upgrade-open', id, method: 'GET', path: target.path, headers: safeHeaders(req.headers, true) });
      stream.timer = setTimeout(() => { if (!stream.head) binding.channel.drop(id); }, 15000); stream.timer.unref();
    } catch { socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n'); }
  });
  const heartbeat = setInterval(() => { for (const binding of bindings.values()) { if (!binding.alive) binding.socket.terminate(); else { binding.alive = false; binding.socket.ping(); } } }, 20000); heartbeat.unref();
  const close = server.close.bind(server);
  server.close = (callback) => { clearInterval(heartbeat); for (const socket of wss.clients) socket.terminate(); server.closeAllConnections(); wss.close(); return close(callback); };
  return server;
}
