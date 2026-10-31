export type PendingAnonymousAccount = { serverOrigin: string; secret: string };
export class AnonymousAccountError extends Error {
    constructor(public code: 'storage' | 'authentication' | 'login' | 'identity', message: string) { super(message); }
}

export class AnonymousAccountCreation {
    private flight: { origin: string; promise: Promise<void> } | null = null;
    constructor(private readonly dependencies: {
        load: (origin: string) => Promise<PendingAnonymousAccount | null>;
        save: (origin: string, account: PendingAnonymousAccount) => Promise<void>;
        clear: (origin: string) => Promise<void>;
        generateSecret: () => Promise<string>;
        authenticate: (secret: string, origin: string) => Promise<string>;
        login: (token: string, secret: string, origin: string) => Promise<void>;
    }) {}

    create(origin: string): Promise<void> {
        if (this.flight) return this.flight.origin === origin ? this.flight.promise : Promise.reject(new AnonymousAccountError('identity', 'Another server account is being created.'));
        const promise = this.perform(origin).finally(() => { this.flight = null; });
        this.flight = { origin, promise }; return promise;
    }
    private async perform(origin: string) {
        let account: PendingAnonymousAccount | null;
        try {
            account = await this.dependencies.load(origin);
            if (!account) {
                account = { serverOrigin: origin, secret: await this.dependencies.generateSecret() };
                // 先安全保存身份再联网；ACK 丢失或凭据保存失败不能让重试生成第二个匿名账号。
                await this.dependencies.save(origin, account);
            }
        } catch { throw new AnonymousAccountError('storage', 'The pending anonymous identity could not be stored securely.'); }
        if (account.serverOrigin !== origin || typeof account.secret !== 'string' || !account.secret) throw new AnonymousAccountError('identity', 'The pending identity belongs to another server.');
        let token: string;
        try { token = await this.dependencies.authenticate(account.secret, origin); }
        catch { throw new AnonymousAccountError('authentication', 'The selected server did not authenticate this identity.'); }
        if (typeof token !== 'string' || !token.trim()) throw new AnonymousAccountError('authentication', 'The selected server returned no valid token.');
        try { await this.dependencies.login(token, account.secret, origin); }
        catch (error) { throw new AnonymousAccountError((error as { code?: string })?.code === 'credential-storage' ? 'storage' : 'login', 'The account could not be saved or initialized.'); }
        // 正常账号已成功保存；清理失败保留同一 seed，不把已经完成的登录误称失败。
        await this.dependencies.clear(origin).catch(() => {});
    }
}
