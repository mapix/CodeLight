import { expect, it } from 'vitest';
import { CodeLightLoadingProgress } from './codeLightLoadingProgress';
it('a stale completion or error cannot hide a newer discovery load', () => {
    const progress = new CodeLightLoadingProgress(), old = progress.beginDiscovery();
    progress.updateDiscovery(old, { found: 200, pages: 1 });
    const current = progress.beginDiscovery(); progress.updateDiscovery(old, { phase: 'complete', found: 1300 });
    expect(progress.getDiscovery()).toMatchObject({ generation: current, phase: 'loading', found: 0 });
    progress.updateDiscovery(old, { phase: 'error' }); expect(progress.getDiscovery().phase).toBe('loading');
});
it('session loading remains separate from discovery and preserves the newer request phase', () => {
    const progress = new CodeLightLoadingProgress(); const first = progress.beginSession('session'), second = progress.beginSession('session');
    progress.endSession('session', first); expect(progress.getSession('session').phase).toBe('loading');
    progress.beginDiscovery(); progress.endSession('session', second, true);
    expect(progress.getSession('session').phase).toBe('error'); expect(progress.getDiscovery().phase).toBe('loading');
});
