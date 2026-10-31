import * as React from 'react';
// @ts-expect-error The native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray', textLink: 'blue' } } }) }));
vi.mock('@/hooks/useCodeLightProjectActivity', () => ({ useCodeLightSessionActivity: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { CodeLightSessionStatusView } from './CodeLightSessionStatus';
const text = (known: boolean, active: boolean, waiting: boolean) => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(CodeLightSessionStatusView, { activity: { known, active, waiting, status: 'ready', observedAt: 1 } })); });
    const value = JSON.stringify(renderer.toJSON()); act(() => renderer.unmount()); return value;
};
it('each list row displays real runtime and waiting state, including their overlap', () => {
    expect(text(true, true, false)).toContain('codeLightSessionStatus.active');
    expect(text(true, true, true)).toContain('codeLightSessionStatus.waiting');
    expect(text(true, false, false)).toContain('codeLightSessionStatus.idle');
    expect(text(false, false, false)).toContain('codeLightSessionStatus.unknown');
    expect(text(false, false, false)).not.toContain('codeLightSessionStatus.idle');
});
