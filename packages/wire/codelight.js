/** CodeLight's portable channel contract; no credentials or IO live here. */
export const CHANNEL_KINDS = Object.freeze(['local', 'cloudflare', 'relay']);
export function isPrivateHost(host) {
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}
export function channelOrigin(value, kind) {
  const url = new URL(value);
  if (!CHANNEL_KINDS.includes(kind) || url.username || url.password || url.search || url.hash
    || url.protocol !== 'https:' && !(url.protocol === 'http:' && kind === 'local' && isPrivateHost(url.hostname))) throw Error('invalid-channel-origin');
  const path = url.pathname.replace(/\/+$/, '');
  if (path && !/^\/r\/[a-f0-9]{24}$/.test(path)) throw Error('invalid-channel-prefix');
  return url.origin + path;
}
export function channelList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw Error('invalid-channel-list');
  const ids = new Set(), origins = new Set();
  return value.map(row => {
    if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id)
      || !CHANNEL_KINDS.includes(row.kind) || typeof row.url !== 'string') throw Error('invalid-channel');
    const url = channelOrigin(row.url, row.kind);
    if (ids.has(row.id) || origins.has(url)) throw Error('duplicate-channel');
    ids.add(row.id); origins.add(url);
    return { id: row.id, kind: row.kind, url, ...(typeof row.label === 'string' ? { label: row.label.slice(0, 80) } : {}) };
  });
}
export function channelPath(origin, requestUrl) {
  const base = new URL(origin), url = new URL(requestUrl, origin + '/');
  if (url.origin !== base.origin || !(url.pathname === base.pathname || url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/'))) throw Error('foreign-channel-request');
  return url.pathname.slice(base.pathname.replace(/\/$/, '').length) || '/';
}
export function peerMaterial(macKey, secret) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(macKey) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw Error('invalid-peer-key');
  return 'CodeLight peer v2\n' + macKey + '\n' + secret;
}
export function rpcTarget(method, params = {}) {
  const key = typeof params.id === 'string' ? ['request', params.id]
    : typeof params.turnId === 'string' ? ['turn', params.turnId]
      : typeof params.sourceKey === 'string' ? ['source', params.sourceKey] : ['entity'];
  return JSON.stringify([method, ...key]);
}
