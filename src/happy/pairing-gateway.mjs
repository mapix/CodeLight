import { createServer, request as proxyRequest } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { channelList, peerMaterial } from '@slopus/happy-wire/codelight';
import { BridgeError } from '../errors.mjs';
import nacl from 'tweetnacl';
import { WebSocketServer } from 'ws';

/** @typedef {Record<string,any>} Value */
const CODE = /^[A-Za-z0-9_-]{43}$/u;

/** Global admission bounds crypto work without trusting forwarded IP headers.
 * @param {{capacity?:number,refillPerSecond?:number,now?:()=>number}} [options] */
function pairingBudget(options = {}) {
  const capacity = options.capacity ?? 12, refill = options.refillPerSecond ?? 1;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 32 || !Number.isFinite(refill) || refill <= 0 || refill > 8) throw Error('invalid-pairing-budget');
  const now = options.now ?? (() => performance.now());
  let tokens = capacity, last = now();
  return () => {
    const at = now();
    if (!Number.isFinite(at)) return false;
    tokens = Math.min(capacity, tokens + Math.max(0, at - last) * refill / 1000); last = Math.max(last, at);
    if (tokens < 1) return false;
    tokens--; return true;
  };
}
/** @param {unknown} value */
function bytes(value) {
  if (typeof value !== 'string' || !CODE.test(value)) throw Error('invalid-pairing-key');
  const result = Buffer.from(value, 'base64url');
  if (result.length !== 32 || result.toString('base64url') !== value) throw Error('invalid-pairing-key');
  return new Uint8Array(result);
}

/** The Mac owns invitations; only the QR-pinned device exchange can reveal its encrypted sync identity. */
export class PairingInvitations {
  /** @param {{key:Uint8Array,credentials:Value,issueCredentials?:(publicKey:string,name:string,issuedAt:number)=>Promise<Value>,now?:()=>number,ttlMs?:number}} options */
  constructor(options) {
    this.options = options; this.now = options.now ?? Date.now;
    this.pair = nacl.box.keyPair.fromSecretKey(options.key);
    /** @type {Map<string,Value>} */ this.invites = new Map();
  }
  /** @param {string} origin @param {Value[]} [channels] */
  issue(origin, channels) {
    const parsed = new URL(origin);
    const prefix = parsed.pathname === '/' ? '' : parsed.pathname;
    if (!['https:', 'http:'].includes(parsed.protocol) || prefix && !/^\/r\/[a-f0-9]{24}$/u.test(prefix) || parsed.origin + prefix !== origin || parsed.username || parsed.password || parsed.search || parsed.hash) throw Error('invalid-pairing-origin');
    const now = this.now();
    for (const [code, grant] of this.invites) if (now >= grant.retainUntil) this.invites.delete(code);
    if (this.invites.size >= 32) throw Error('pairing-invitation-capacity');
    const invite = randomBytes(32).toString('base64url'), expires = now + (this.options.ttlMs ?? 180000);
    const key = Buffer.from(this.pair.publicKey).toString('base64url');
    const choices = channels ? channelList(channels) : null;
    if (choices && !choices.some(choice => choice.url === origin)) throw Error('invalid-pairing-origin');
    this.invites.set(invite, { origin, channels: choices, issuedAt: now, expires, retainUntil: expires, deviceKey: null, reply: null });
    const url = new URL('codelight://pair');
    for (const [name, value] of Object.entries({ v: choices ? '2' : '1', origin, invite, key, expires: String(expires), ...(choices ? { channels: Buffer.from(JSON.stringify(choices)).toString('base64url') } : {}) })) url.searchParams.set(name, value);
    return { url: url.toString(), expires, key };
  }
  /** @param {{invite:string,publicKey:string,deviceName?:string}} input */
  exchange(input) {
    const publicKey = bytes(input.publicKey), grant = this.invites.get(input.invite), now = this.now();
    if (!grant || now >= grant.retainUntil || !grant.reply && now >= grant.expires) throw Error('pairing-invitation-expired');
    if (grant.deviceKey && grant.deviceKey !== input.publicKey) throw Error('pairing-invitation-used');
    if (grant.reply) return grant.reply;
    if (this.options.issueCredentials) {
      if (grant.flight) return grant.flight;
      grant.deviceKey = input.publicKey;
      grant.flight = this.options.issueCredentials(input.publicKey, input.deviceName ?? 'Phone', grant.issuedAt).then(credentials => this.reply(grant, publicKey, input.publicKey, credentials))
        .catch(error => { grant.deviceKey = null; throw error; }).finally(() => { grant.flight = null; });
      return grant.flight;
    }
    return this.reply(grant, publicKey, input.publicKey, this.options.credentials);
  }
  /** @param {Value} grant @param {Uint8Array} publicKey @param {string} encodedKey @param {Value} credentials */
  reply(grant, publicKey, encodedKey, credentials) {
    const macKey = Buffer.from(this.pair.publicKey).toString('base64url');
    const peer = grant.channels ? { id: createHash('sha256').update(peerMaterial(macKey, credentials.secret)).digest('hex'), key: macKey, channels: grant.channels } : null;
    const payload = Buffer.from(JSON.stringify({ version: peer ? 2 : 1, origin: grant.origin, macKey,
      ...(peer ? { peer } : {}), credentials: { ...credentials, serverUrl: grant.origin } }));
    const nonce = randomBytes(24), cipher = nacl.box(payload, nonce, publicKey, this.pair.secretKey);
    grant.deviceKey = encodedKey;
    grant.reply = { version: peer ? 2 : 1, macKey, nonce: nonce.toString('base64url'), ciphertext: Buffer.from(cipher).toString('base64url') };
    // 同一手机丢 ACK 后复用原密文；换设备密钥不能消费已经使用过的邀请。
    grant.retainUntil = this.now() + 15 * 60 * 1000;
    return grant.reply;
  }
  /** @param {{publicKey:string,nonce:string,ciphertext:string}} input */
  exchangeEncrypted(input) {
    const publicKey = bytes(input.publicKey), nonce = Buffer.from(input.nonce, 'base64url'), cipher = Buffer.from(input.ciphertext, 'base64url');
    if (nonce.length !== 24 || cipher.length < 16 || cipher.length > 4096) throw Error('invalid-pairing-request');
    const plain = nacl.box.open(cipher, nonce, publicKey, this.pair.secretKey);
    if (!plain) throw Error('invalid-pairing-request');
    const request = JSON.parse(Buffer.from(plain).toString('utf8'));
    if (!request || Object.keys(request).some(key => !['invite', 'origin', 'version', 'deviceName'].includes(key)) || ![1, 2].includes(request.version) ||
        typeof request.invite !== 'string' || !CODE.test(request.invite) || typeof request.origin !== 'string') throw Error('invalid-pairing-request');
    const grant = this.invites.get(request.invite);
    if (grant && !(grant.channels ? request.version === 2 && grant.channels.some((/** @type {Value} */ choice) => choice.url === request.origin) : request.version === 1 && grant.origin === request.origin)) throw Error('invalid-pairing-origin');
    return this.exchange({ invite: request.invite, publicKey: input.publicKey, deviceName: typeof request.deviceName === 'string' ? request.deviceName.slice(0, 80) : 'Phone' });
  }
  close() { this.invites.clear(); this.pair.secretKey.fill(0); }
}

/** @param {import('node:http').IncomingMessage} req */
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw Error('pairing-request-too-large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'ciphertext,nonce,publicKey' ||
      typeof value.nonce !== 'string' || typeof value.ciphertext !== 'string') throw Error('invalid-pairing-request');
  return value;
}

/** Only this loopback API is proxied; invitations are exchanged, never enumerated through the public tunnel.
 * @param {{upstream:string,invitations:PairingInvitations,devices?:import('./device-registry.mjs').DeviceRegistry,notificationsAvailable?:boolean,metrics?:Pick<import('./gateway-metrics.mjs').GatewayMetrics,'trackSocket'|'request'>,pairingBudget?:{capacity?:number,refillPerSecond?:number,now?:()=>number},entryProbe?:(challenge:unknown)=>string|null,proof?:import('../network/device-proof.mjs').DeviceProofVerifier,requireProof?:boolean,expectedOrigin?:()=>string|null,onVerified?:()=>void,peerApi?:(path:string,method:string,body:Value,device:string)=>Promise<Value>,peerId?:()=>string}} options */
export function createPairingGateway(options) {
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(upstream.hostname)) throw Error('invalid-pairing-upstream');
  const admitPairing = pairingBudget(options.pairingBudget);
  const probes = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  /** @param {import('node:http').IncomingMessage} req */
  const authorize = req => {
    const proof = options.proof?.authorize(req.headers.authorization, req.method ?? 'GET', req.url ?? '/', options.expectedOrigin?.());
    if (proof) { req.headers.authorization = 'Bearer ' + proof.token; options.onVerified?.(); return proof.id; }
    if (options.requireProof) return null;
    return options.devices?.authorize(req.headers.authorization?.replace(/^Bearer /u, '')) ?? null;
  };
  const server = createServer({ headersTimeout: 10000, requestTimeout: 60000, keepAliveTimeout: 5000 }, async (req, res) => {
    try { options.metrics?.request(); } catch { /* 统计失败不能阻断配对或同步。 */ }
    if (req.url?.split('?')[0] === '/codelight/entry-probe') {
      const reply = options.entryProbe?.(new URL(req.url, 'http://127.0.0.1').searchParams.get('challenge'));
      res.setHeader('Cache-Control', 'no-store'); res.writeHead(reply ? 200 : 404).end(reply ?? ''); return;
    }
    if (req.url?.split('?')[0] === '/codelight/pairing/exchange') {
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'POST') { res.writeHead(405).end('{}'); return; }
      // 公网未配对请求也会触发密钥运算；在读取/解密前限流，且不依据可伪造的代理 IP。
      if (!admitPairing()) { res.setHeader('Retry-After', '1'); res.setHeader('Connection', 'close'); res.writeHead(429).end('{}'); req.resume(); return; }
      try { res.end(JSON.stringify(await options.invitations.exchangeEncrypted(await readBody(req)))); }
      catch (error) {
        const code = error instanceof Error ? error.message : 'pairing-failed';
        const status = code === 'pairing-invitation-used' ? 409 : code === 'pairing-invitation-expired' ? 410 : 400;
        res.writeHead(status).end(JSON.stringify({ error: code }));
      }
      return;
    }
    const localPath = req.url?.split('?')[0];
    if (localPath?.startsWith('/api/peer/')) {
      const device = authorize(req);
      if (!device || !options.peerApi || !options.devices) { res.writeHead(401).end(); return; }
      try {
        let body = ''; for await (const chunk of req) { body += chunk.toString(); if (body.length > 4096) throw Error('request-too-large'); }
        const payload = await options.peerApi(req.url ?? '', req.method ?? 'GET', body ? JSON.parse(body) : {}, device);
        const encoded = Buffer.from(JSON.stringify({ peerId: options.peerId?.(), payload }));
        if (encoded.length > 8 * 1024 * 1024) throw Error('peer-response-too-large');
        const key = options.devices.publicKey(device); if (!key) throw Error('unknown-device');
        const nonce = randomBytes(24), ciphertext = nacl.box(encoded, nonce, bytes(key), options.invitations.pair.secretKey);
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ version: 2, nonce: nonce.toString('base64url'), ciphertext: Buffer.from(ciphertext).toString('base64url') }));
      } catch (error) {
        const status = error instanceof BridgeError ? error.status : 400;
        const code = error instanceof BridgeError && /^[a-z][a-z0-9-]{0,80}$/u.test(error.code) ? error.code : 'peer-request-failed';
        res.setHeader('Content-Type','application/json'); res.writeHead(status).end(JSON.stringify({error:code}));
      }
      return;
    }
    if (localPath === '/codelight/notifications/device' || localPath === '/codelight/notifications/presence') {
      const device = authorize(req);
      if (!device) { res.writeHead(401).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      try {
        let text = ''; for await (const chunk of req) { text += chunk.toString(); if (text.length > 4096) throw Error('request-too-large'); }
        const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid-device-request');
        if (localPath.endsWith('/device')) await options.devices?.registerPush(device, value);
        else options.devices?.viewingPresence(device, value);
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ registered: true, available: options.notificationsAvailable === true }));
      } catch { res.writeHead(400).end('{}'); }
      return;
    }
    if (req.url?.startsWith('/codelight/')) { res.writeHead(404).end(); return; }
    const path = req.url?.split('?')[0];
    if (options.devices && (path?.startsWith('/v1/auth') || path !== '/health' && !authorize(req))) {
      res.writeHead(401).end(); return;
    }
    const proxy = proxyRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url,
      method: req.method, headers: { ...req.headers, host: upstream.host } }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => proxy.destroy()); req.pipe(proxy);
  });
  server.maxConnections = 128;
  /** @type {Set<import('node:net').Socket>} */ const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    try { options.metrics?.trackSocket(socket); } catch { /* 统计只观察 owned client socket，不接管其生命周期。 */ }
  });
  const closeConnections = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => { for (const socket of sockets) socket.destroy(); closeConnections(); };
  server.on('upgrade', (req, socket, head) => {
    try { options.metrics?.request(); } catch { /* HTTP upgrade 只计一次请求，不重复累计上游流量。 */ }
    if (req.url?.split('?')[0] === '/codelight/entry-probe') {
      const reply = options.entryProbe?.(new URL(req.url, 'http://127.0.0.1').searchParams.get('challenge'));
      if (!reply) { socket.destroy(); return; }
      probes.handleUpgrade(req, socket, head, ws => { ws.send(reply); ws.close(); }); return;
    }
    // Happy 的实时通道是 /v1/updates；误用 socket.io 默认路径会让 HTTP 列表可读而控制链路一直报错。
    const path = req.url?.split('?')[0];
    if (path !== '/v1/updates' && path !== '/v1/updates/') { socket.destroy(); return; }
    const device = authorize(req);
    if (options.devices && !device) { socket.destroy(); return; }
    if (device) options.devices?.connected(device, /** @type {import('node:net').Socket} */ (socket));
    const proxy = proxyRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url,
      headers: { ...req.headers, host: upstream.host } });
    proxy.on('upgrade', (response, remote, responseHead) => {
      const headers = Object.entries(response.headers).flatMap(([key, value]) => Array.isArray(value) ? value.map(v => `${key}: ${v}`) : [`${key}: ${value}`]);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (responseHead.length) socket.write(responseHead);
      if (head.length) remote.write(head);
      socket.pipe(remote); remote.pipe(socket);
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
    });
    proxy.on('error', () => socket.destroy()); proxy.end();
  });
  return server;
}
