import { describe, expect, it } from 'vitest';
import { AgentStateSchema } from './storageTypes';

describe('native window observation', () => {
    it('retains the source-bound image, stamp and native controls', () => {
        const frame = { imageRef: 'source-image-ref', captureStamp: { runtimeGeneration: 'original-pid', windowGeneration: 'window-1' }, bounds: { x: 0, y: 0, width: 1200, height: 800 },
            controls: [{ nodeId: 'real-native-node', role: 'AXButton', enabled: true, text: { title: 'Send' } }], coordinateControlAvailable: true };
        expect(AgentStateSchema.parse({ windowObservation: frame }).windowObservation).toEqual(frame);
    });
    it('drops malformed window data without removing unrelated pending requests', () => {
        const parsed = AgentStateSchema.parse({ windowObservation: { imageRef: 42, controls: 'invalid' }, requests: { permission: { tool: 'Shell', arguments: {} } } });
        expect(parsed.windowObservation).toBeUndefined();
        expect(parsed.requests?.permission.tool).toBe('Shell');
    });
});
