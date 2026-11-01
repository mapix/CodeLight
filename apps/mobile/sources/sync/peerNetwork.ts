import nacl from 'tweetnacl';
import { getRandomBytes } from 'expo-crypto';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { channelPath, type PeerCredentials } from '@slopus/happy-wire/codelight';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { isSameServerEndpoint } from '@/utils/serverOrigin';

export function peerAuthorization(token: string, peer: PeerCredentials, origin: string, method: string, url: string): string {
    if (!peer.channels.some(channel => channel.url === origin)) throw Error('The selected channel does not belong to this Mac');
    // 冷启动 sync 早于 PairingProvider：nonce 直接取系统安全随机源，不能依赖界面安装全局 PRNG。
    const nonce = getRandomBytes(24);
    const payload = new TextEncoder().encode(JSON.stringify({ version: 2, token, origin, method, path: channelPath(origin, url), at: Date.now() }));
    const ciphertext = nacl.box(payload, nonce, decodeBase64(peer.key, 'base64url'), decodeBase64(peer.device.secretKey, 'base64url'));
    return 'CodeLight ' + encodeBase64(new TextEncoder().encode(JSON.stringify({ publicKey: peer.device.publicKey, nonce: encodeBase64(nonce, 'base64url'), ciphertext: encodeBase64(ciphertext, 'base64url') })), 'base64url');
}
export function credentialHeaders(credentials:AuthCredentials,url:string,method:string,base:string):Record<string,string> {
    if(credentials.peer){
        const channel=credentials.peer.channels.find(current=>isSameServerEndpoint(url,current.url));
        return channel?{Authorization:peerAuthorization(credentials.token,credentials.peer,channel.url,method,url)}:{};
    }
    return isSameServerEndpoint(url,base)?{Authorization:`Bearer ${credentials.token}`}:{ };
}

export function decodePeerResponse(peer: PeerCredentials, value: unknown): unknown {
    const packet = value as { version?: number; nonce: string; ciphertext: string };
    if (packet?.version !== 2 || typeof packet.nonce !== 'string' || typeof packet.ciphertext !== 'string') throw Error('Invalid Mac response');
    const plain = nacl.box.open(decodeBase64(packet.ciphertext, 'base64url'), decodeBase64(packet.nonce, 'base64url'), decodeBase64(peer.key, 'base64url'), decodeBase64(peer.device.secretKey, 'base64url'));
    if (!plain) throw Error('The response did not authenticate this Mac');
    const decoded = JSON.parse(new TextDecoder().decode(plain));
    if (decoded.peerId !== peer.id) throw Error('The response belongs to another Mac');
    return decoded.payload;
}
