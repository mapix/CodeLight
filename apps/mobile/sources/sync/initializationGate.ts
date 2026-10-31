/** Account initialization is successful only when its whole promise succeeds. */
export class InitializationGate {
    private initializedKey: string | null = null;
    private flight: { key: string; promise: Promise<void> } | null = null;
    run(key: string, initialize: () => Promise<void>, cleanup: () => void): Promise<void> {
        if (this.initializedKey !== null) return this.initializedKey === key ? Promise.resolve() : Promise.reject(Error('Changing account or server requires an application reload.'));
        if (this.flight) return this.flight.key === key ? this.flight.promise : Promise.reject(Error('Another account is being initialized.'));
        const promise = initialize().then(() => { this.initializedKey = key; }).catch(error => { cleanup(); throw error; }).finally(() => { this.flight = null; });
        this.flight = { key, promise }; return promise;
    }
}
