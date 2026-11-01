import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { channelPath } from '@slopus/happy-wire/codelight';

/** Private-LAN authorization keeps device bearer tokens inside the sealed box. */
export class DeviceProofVerifier {
  /** @param {{key:Uint8Array,devices:{authorize:(token:unknown)=>string|null},origins:()=>string[],now?:()=>number}} options */
  constructor({ key, devices, origins, now = Date.now }) {
    this.key = key; this.devices = devices; this.origins = origins; this.now = now; this.seen = /** @type {Map<string,number>} */ (new Map());
  }
  /** @param {unknown} header @param {string} method @param {string} requestUrl @param {string|null} [expectedOrigin] */
  authorize(header, method, requestUrl, expectedOrigin) {
    if (typeof header !== 'string' || !header.startsWith('CodeLight ') || header.length > 8192) return null;
    try {
      const packet = JSON.parse(Buffer.from(header.slice(10), 'base64url').toString());
      if (!/^[A-Za-z0-9_-]{43}$/.test(packet.publicKey) || !/^[A-Za-z0-9_-]{32}$/.test(packet.nonce) || typeof packet.ciphertext !== 'string') return null;
      const publicKey = Buffer.from(packet.publicKey, 'base64url'), nonce = Buffer.from(packet.nonce, 'base64url');
      const plain = nacl.box.open(Buffer.from(packet.ciphertext, 'base64url'), nonce, publicKey, this.key);
      if (!plain) return null;
      const proof = JSON.parse(Buffer.from(plain).toString());
      if (proof.version !== 2 || !Number.isSafeInteger(proof.at) || Math.abs(this.now() - proof.at) > 60000
        || proof.method !== method || !this.origins().includes(proof.origin) || expectedOrigin && proof.origin !== expectedOrigin || proof.path !== channelPath(proof.origin, proof.origin + requestUrl)) return null;
      const deviceId = this.devices.authorize(proof.token);
      if (!deviceId || deviceId !== createHash('sha256').update(packet.publicKey).digest('hex').slice(0, 24)) return null;
      // 一份设备证明只能使用一次；所有入口共享该 owner，不能跨内网接口重放。
      const replay = packet.publicKey + ':' + packet.nonce;
      if (this.seen.has(replay)) return null;
      for (const [id, until] of this.seen) if (until < this.now()) this.seen.delete(id);
      if (this.seen.size >= 10000) return null;
      this.seen.set(replay, this.now() + 60000);
      return { id: deviceId, token: proof.token };
    } catch { return null; }
  }
}
