/** Deduplicates a visit and resume while the encrypted metadata is catching up. */
export class CodeLightActivationGate {
    private flights = new Map<string, Promise<unknown>>();
    private confirmed = new Set<string>();
    run(identity: string, activate: () => Promise<unknown>): Promise<unknown> {
        if (this.confirmed.has(identity)) return Promise.resolve();
        const existing = this.flights.get(identity);
        if (existing) return existing;
        const flight = Promise.resolve().then(activate).then(value => {
            this.confirmed.add(identity);
            return value;
        }).finally(() => this.flights.delete(identity));
        this.flights.set(identity, flight);
        return flight;
    }
}
