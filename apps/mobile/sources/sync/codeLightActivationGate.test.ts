import { expect, it } from 'vitest';
import { CodeLightActivationGate } from './codeLightActivationGate';

it('deduplicates visits and successful resumes while fencing each owner identity', async () => {
    const gate = new CodeLightActivationGate(); let calls = 0;
    const start = async () => { calls++; return 'connected'; };
    await Promise.all([gate.run('account:owner1', start), gate.run('account:owner1', start)]);
    await gate.run('account:owner1', start); expect(calls).toBe(1);
    await gate.run('account:owner2', start); expect(calls).toBe(2);
});
it('does not remember rejected activation as successful', async () => {
    const gate = new CodeLightActivationGate();
    await expect(gate.run('owner', async () => { throw Error('offline'); })).rejects.toThrow('offline');
    await expect(gate.run('owner', async () => 'connected')).resolves.toBe('connected');
});
