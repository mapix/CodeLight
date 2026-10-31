import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
const mocks = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn(), recover: vi.fn() }));
vi.mock('@/sync/noninvasiveRpc', () => ({ runCodeLightModelRpc: mocks.write, recoverCodeLightModelRpc: mocks.recover }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: mocks.read } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { useCodeLightModelControls } from './useCodeLightModelControls';
const fixture = { id: 'relay', metadata: { client: { id: 'noninvasive-bridge' }, capabilities: { rpcMethods: ['codex-controls-read'] }, nativeControls: { model: { available: true,
    current: { model: 'a', reasoningEffort: 'low', modelProvider: 'fixture' }, models: [{ id: 'a', label: 'Model A', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }, { id: 'b', label: 'Model B', reasoningEfforts: ['medium', 'high'], defaultReasoningEffort: 'medium' }] } } } } as unknown as Session;
let controls!: ReturnType<typeof useCodeLightModelControls>;
function Harness() { controls = useCodeLightModelControls(fixture); return null; }
it('writes the original settings with compare conditions and leaves displayed state owned by native metadata', async () => {
    mocks.write.mockResolvedValue(undefined); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let root!: ReturnType<typeof create>; act(() => { root = create(React.createElement(Harness)); });
    await act(async () => { controls.selectModel(controls.models[1]); });
    expect(mocks.write).toHaveBeenCalledWith('relay', { model: 'b', reasoningEffort: 'medium', expectedModel: 'a', expectedReasoningEffort: 'low' });
    expect(controls.currentModel?.key).toBe('a'); act(() => root.unmount());
});
it('does not offer unsupported reasoning levels', async () => {
    mocks.write.mockClear(); let root!: ReturnType<typeof create>; act(() => { root = create(React.createElement(Harness)); });
    await act(async () => { controls.selectEffort({ key: 'unsupported', name: 'Unsupported' }); });
    expect(mocks.write).not.toHaveBeenCalled(); act(() => root.unmount());
});
