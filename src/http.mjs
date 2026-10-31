import { BridgeError } from './errors.mjs';

/** @param {import('node:http').IncomingMessage} request @param {number} [maxBytes] */
export async function readJson(request, maxBytes = 128 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new BridgeError('payload-too-large', '内容太长，请分段发送。', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('object-required');
    return value;
  }
  catch { throw new BridgeError('invalid-json', '请求内容无效。'); }
}

/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} value */
export function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

/** @param {import('node:http').IncomingMessage} request @param {ReadonlySet<string>} hosts @param {string|undefined} [relayOrigin] @param {boolean} [nativeAuthenticated] */
export function verifyOrigin(request, hosts, relayOrigin, nativeAuthenticated = false) {
  if (!request.headers.host || !hosts.has(request.headers.host)) throw new BridgeError('invalid-host', '连接地址无效。', 403);
  if (request.method === 'POST') {
    const origin = request.headers.origin;
    if (nativeAuthenticated && !origin) return;
    if (!origin) throw new BridgeError('origin-required', '请从手机页面发起操作。', 403);
    const allowed = [`http://${request.headers.host}`, `https://${request.headers.host}`, ...(relayOrigin ? [relayOrigin] : [])];
    if (!allowed.includes(origin)) throw new BridgeError('origin-denied', '请从已配对的页面发起操作。', 403);
  }
}

/** @param {import('node:http').ServerResponse} response @param {string} name @param {unknown} value */
export function event(response, name, value) {
  if (response.destroyed) return false;
  if (response.writableLength > 2 * 1024 * 1024) { response.destroy(); return false; }
  return response.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
}
