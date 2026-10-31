/** One explicit server or authenticated network-relay base, without URL credentials. */
export function normalizeServerOrigin(value: string): string {
    const input = value.trim();
    if (!/^https?:\/\//i.test(input)) throw Error('Use an explicit HTTP or HTTPS server address.');
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
        || url.search || url.hash || url.pathname !== '/' && !/^\/r\/[a-f0-9]{24}\/?$/.test(url.pathname)) throw Error('Use a server origin or a validated relay base without credentials, query, or fragment.');
    return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
}

export function serverEndpoint(base: string, path: string): URL {
    if (!path.startsWith('/') || path.startsWith('//')) throw Error('Use an absolute API path.');
    return new URL(normalizeServerOrigin(base) + path);
}

export function socketServerEndpoint(base: string): { origin: string; path: string } {
    const url = new URL(normalizeServerOrigin(base));
    return { origin: url.origin, path: (url.pathname === '/' ? '' : url.pathname) + '/v1/updates' };
}

/** 同域下不同 Mac 的 relay prefix 也属于不同凭据边界，不能只比较 hostname。 */
export function isSameServerEndpoint(target: string, base: string): boolean {
    try {
        const url = new URL(target), origin = new URL(normalizeServerOrigin(base));
        return url.protocol === origin.protocol && !url.username && !url.password && url.origin === origin.origin && (origin.pathname === '/' || url.pathname === origin.pathname || url.pathname.startsWith(origin.pathname + '/'));
    } catch { return false; }
}

export function codeLightMacCommand(origin: string): string {
    const address = normalizeServerOrigin(origin).replace(/'/g, "'\\''");
    return `./start-codelight.sh --server='${address}'`;
}
