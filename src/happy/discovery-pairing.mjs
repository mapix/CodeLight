import nacl from 'tweetnacl';
import { randomBytes } from 'node:crypto';
import { writeDurablePrivateJson, readOptionalPrivateJson } from './discovery-persistence.mjs';

/** @param {string} value */
export function normalizeServerOrigin(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw Error('Use a plain HTTP(S) server origin without credentials, paths or query strings.');
  return parsed.origin;
}

/** @typedef {Record<string,any>} Value */
/** @param {{serverUrl:string,accountPath:string,fetch?:typeof fetch,onLink?:(link:string)=>void,signal?:AbortSignal,timeoutMs?:number,pollMs?:number}} options */
export async function pairCodeLight(options) {
  const serverUrl = normalizeServerOrigin(options.serverUrl);
  const previous = await readOptionalPrivateJson(options.accountPath);
  if (previous) {
    if (previous.serverUrl !== serverUrl || typeof previous.token !== 'string' || Buffer.from(previous.secret ?? '', 'base64url').length !== 32) throw Error('This CodeLight profile belongs to another server or has invalid credentials. Use a separate profile.');
    return previous;
  }
  const requestFetch = options.fetch ?? fetch;
  const keypair = nacl.box.keyPair.fromSecretKey(new Uint8Array(randomBytes(32)));
  const publicKey = Buffer.from(keypair.publicKey).toString('base64');
  const link = `codelight://terminal?${Buffer.from(keypair.publicKey).toString('base64url')}`;
  const started = Date.now(); let announced = false;
  try {
    while (Date.now() - started < (options.timeoutMs ?? 5 * 60_000)) {
      options.signal?.throwIfAborted();
      const requestSignal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
      const response = await requestFetch(`${serverUrl}/v1/auth/request`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Happy-Client': 'codelight/0.2.0' }, body: JSON.stringify({ publicKey, supportsV2: false }), signal: requestSignal });
      if (!response.ok) throw Error(`CodeLight pairing request failed (${response.status}).`);
      const answer = /** @type {Value} */ (await response.json());
      options.signal?.throwIfAborted();
      if (!announced) { options.onLink?.(link); announced = true; }
      if (answer.state === 'authorized') {
        if (typeof answer.response !== 'string' || typeof answer.token !== 'string' || !answer.token) throw Error('The pairing reply is incomplete.');
        const bundle = Buffer.from(answer.response, 'base64');
        if (bundle.length < 32 + 24 + 16) throw Error('The encrypted pairing reply is invalid.');
        const secret = nacl.box.open(bundle.subarray(56), bundle.subarray(32, 56), bundle.subarray(0, 32), keypair.secretKey);
        if (!secret || secret.length !== 32) throw Error('The approved account key could not be decrypted.');
        const account = { version: 1, serverUrl, token: answer.token, secret: Buffer.from(secret).toString('base64'), pairedAt: new Date().toISOString() };
        await writeDurablePrivateJson(options.accountPath, account); secret.fill(0); return account;
      }
      if (answer.state !== 'requested') throw Error('The pairing server returned an unsupported state.');
      await new Promise((resolveWait, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(options.signal?.reason ?? Error('Pairing aborted.')); };
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort', onAbort); resolveWait(undefined); }, options.pollMs ?? 1000);
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    throw Error('CodeLight pairing timed out. Run again to display a new link.');
  } finally { keypair.secretKey.fill(0); }
}
