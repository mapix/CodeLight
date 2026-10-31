import { get } from 'node:https';
import { isIP } from 'node:net';

/** Checks only the owned public tunnel; the machine's DNS and other applications are never changed.
 * @param {string} origin @returns {Promise<boolean>} */
export async function tunnelHealth(origin) {
  try { if ((await fetch(origin + '/health', { signal: AbortSignal.timeout(3000) })).ok) return true; }
  catch { /* A failed system resolver/route is checked against the same TLS hostname below. */ }
  const url = new URL(origin);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.trycloudflare.com')) return false;
  // 本机 DNS 对已存在的 Quick Tunnel 返回 NXDOMAIN；仅这个 CodeLight 探测使用 DoH，TLS 仍校验原 hostname。
  const response = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(url.hostname) + '&type=A',
    { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
  const data = /** @type {{Status?:number,Answer?:{type:number,data:string}[]}} */ (await response.json());
  const address = data.Status === 0 ? data.Answer?.find(answer => answer.type === 1 && isIP(answer.data) === 4)?.data : null;
  if (!address) return false;
  return new Promise(resolveHealth => {
    const request = get(origin + '/health', { servername: url.hostname,
      lookup: (_host, options, callback) => {
        const cb = /** @type {any} */ (callback);
        if (typeof options === 'object' && options.all) cb(null, [{ address, family: 4 }]); else cb(null, address, 4);
      } }, result => { result.resume(); resolveHealth(result.statusCode === 200); });
    request.setTimeout(5000, () => request.destroy(Error('tunnel-health-timeout')));
    request.on('error', () => resolveHealth(false));
  });
}
