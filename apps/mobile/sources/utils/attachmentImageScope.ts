/** Cache identity is private and in memory; the same ref must not cross account or source. */
export function attachmentImageScope(serverUrl: string, token: string | null, sessionId: string, ref: string | undefined): string | null {
    return token && sessionId && ref ? JSON.stringify([serverUrl, token, sessionId, ref]) : null;
}
