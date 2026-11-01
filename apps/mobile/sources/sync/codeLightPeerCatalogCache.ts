import type { AuthCredentials } from '@/auth/tokenStorage';
import { encryptBlob, decryptBlob } from '@/encryption/blob';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { encodeUTF8, decodeUTF8 } from '@/encryption/text';
import { codeLightAccountScope, loadCodeLightBackgroundCache, saveCodeLightBackgroundCache } from './codeLightBackgroundCache';
import { peerDescriptorSession, type PeerSessionDescriptor } from './codeLightRecent';
const MAX_BYTES = 16 * 1024 * 1024;

/** 缓存只使目录可浏览；当前会话事实仍由独立的新鲜 recent 读取确认。 */
export async function loadCodeLightPeerCatalog(credentials: AuthCredentials): Promise<PeerSessionDescriptor[]> {
    if (!credentials.peer) return [];
    const scope = await codeLightAccountScope(credentials), ciphertext = loadCodeLightBackgroundCache(scope).peerCatalogCiphertext;
    if (!ciphertext || ciphertext.length > MAX_BYTES * 2) return [];
    try {
        const plain = decryptBlob(decodeBase64(ciphertext, 'base64'), decodeBase64(credentials.secret, 'base64url'));
        if (!plain || plain.length > MAX_BYTES) return [];
        const value = JSON.parse(decodeUTF8(plain));
        if (value.version !== 1 || value.scope !== scope || !Array.isArray(value.sessions) || value.sessions.length > 10000) return [];
        return value.sessions.map((row: PeerSessionDescriptor) => {
            const stale = { ...row, active: false, agentState: null, basicOnly: true };
            peerDescriptorSession(stale); return stale;
        });
    } catch { return []; }
}
export async function saveCodeLightPeerCatalog(credentials: AuthCredentials, sessions: PeerSessionDescriptor[], current: () => boolean) {
    const scope = await codeLightAccountScope(credentials);
    if (!current() || sessions.length > 10000) return;
    const plain = encodeUTF8(JSON.stringify({ version: 1, scope, sessions }));
    if (plain.length > MAX_BYTES) return;
    const peerCatalogCiphertext = encodeBase64(encryptBlob(plain, decodeBase64(credentials.secret, 'base64url')), 'base64');
    if (current()) saveCodeLightBackgroundCache({ ...loadCodeLightBackgroundCache(scope), peerCatalogCiphertext, updatedAt: Date.now() });
}
