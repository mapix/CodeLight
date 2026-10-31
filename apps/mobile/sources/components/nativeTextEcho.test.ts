import { describe, expect, it } from 'vitest';
import { NativeTextEcho } from './nativeTextEcho';

describe('native text echo ownership', () => {
    it('acknowledges an old parent echo without replacing a newer native edit', () => {
        const echoes = new NativeTextEcho();
        echoes.record('R', 1); echoes.record('Re', 2);
        expect(echoes.acknowledge('R')).toBe(true);
        expect(echoes.acknowledge('Re')).toBe(true);
        expect(echoes.acknowledge('R')).toBe(false);
    });
    it('consumes skipped earlier echoes and keeps external clears and later identical writes explicit', () => {
        const echoes = new NativeTextEcho();
        echoes.record('R', 1); echoes.record('Re', 2); echoes.record('Reply', 3);
        expect(echoes.acknowledge('Reply')).toBe(true);
        expect(echoes.acknowledge('')).toBe(false);
        echoes.externalWrite();
        expect(echoes.acknowledge('Reply')).toBe(false);
    });
    it('does not accept a stale event count as a new echo', () => {
        const echoes = new NativeTextEcho();
        echoes.record('Reply', 3); echoes.record('Re', 2);
        expect(echoes.acknowledge('Re')).toBe(false);
    });
    it('consumes the newest identical edit so an older intermediate value cannot swallow an external change', () => {
        const echoes = new NativeTextEcho();
        echoes.record('R', 1); echoes.record('Re', 2); echoes.record('R', 3);
        expect(echoes.acknowledge('R')).toBe(true);
        expect(echoes.acknowledge('Re')).toBe(false);
    });
});
