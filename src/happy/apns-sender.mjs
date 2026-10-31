import { readFile } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
import { connect } from 'node:http2';
import { isAbsolute } from 'node:path';
import { readOptionalPrivateJson } from './discovery-persistence.mjs';
/** @typedef {Record<string,any>} Value */
/** Private local publisher configuration. @param {string} path */
export async function loadAPNsSender(path) {
  const config = await readOptionalPrivateJson(path);
  if (!config) return null;
  if (!isAbsolute(config.keyPath ?? '') || !/^[A-Z0-9]{10}$/u.test(config.keyId ?? '') || !/^[A-Z0-9]{10}$/u.test(config.teamId ?? '') || config.topic !== 'com.learnings.codelight' || !['development', 'production'].includes(config.environment)) throw Error('invalid-apns-configuration');
  const privateKey = createPrivateKey(await readFile(config.keyPath));
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw Error('invalid-apns-key');
  let jwt = '', signedAt = 0;
  return { environment: config.environment,
    /** @param {string} token @param {Value} event */
    async send(token, event) {
      const now = Math.floor(Date.now() / 1000);
      if (!jwt || now - signedAt > 3000) {
        const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
        const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: now })).toString('base64url');
        const unsigned = header + '.' + claims;
        jwt = unsigned + '.' + sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'); signedAt = now;
      }
      const client = connect(config.environment === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
      try { return await new Promise((resolve, reject) => {
        client.once('error', () => reject(Error('apns-transport-failed')));
        const req = client.request({ ':method': 'POST', ':path': `/3/device/${token}`, authorization: 'bearer ' + jwt, 'apns-topic': config.topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(now + 3600), 'apns-collapse-id': event.id.slice(0, 64) });
        let status = 0, body = '';
        req.setTimeout(15000, () => { req.close(); reject(Error('apns-timeout')); });
        req.on('response', headers => { status = Number(headers[':status']); });
        req.on('data', chunk => { body = (body + chunk.toString()).slice(0, 4096); });
        req.on('error', () => reject(Error('apns-transport-failed')));
        req.on('end', () => {
          let reason = ''; try { reason = JSON.parse(body).reason ?? ''; } catch { /* HTTP status remains authoritative. */ }
          resolve({ ok: status === 200, invalidToken: status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(reason), retry: status === 429 || status >= 500 });
        });
        req.end(JSON.stringify({ aps: { alert: { title: 'CodeLight', body: event.kind === 'completed' ? 'A session has finished.' : event.kind === 'failed' ? 'A session needs attention.' : 'A session is waiting for your input.' }, sound: 'default' }, sessionId: event.sessionId, eventId: event.id, origin: event.origin }));
      }); } finally { client.destroy(); }
    }
  };
}
