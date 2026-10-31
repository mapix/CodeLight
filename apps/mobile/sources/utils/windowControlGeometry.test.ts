import { describe, expect, it } from 'vitest';
import { previewImagePoint } from './windowControlGeometry';

describe('native window image control', () => {
    const geometry = { centerX: 200, centerY: 400, imageWidth: 400, imageHeight: 300, scale: 1, x: 0, y: 0 };
    it('maps the actual centered image including padding rather than the screen rectangle', () => {
        expect(previewImagePoint(200, 400, geometry)).toEqual({ x: 0.5, y: 0.5 });
        expect(previewImagePoint(0, 250, geometry)).toEqual({ x: 0, y: 0 });
        expect(previewImagePoint(400, 550, geometry)).toBeNull();
        expect(previewImagePoint(200, 200, geometry)).toBeNull();
    });
    it('reverses zoom and pan so the same desktop point stays the same', () => {
        expect(previewImagePoint(340, 380, { ...geometry, scale: 2, x: 40, y: -20 })).toEqual({ x: 0.625, y: 0.5 });
    });
    it('rejects invalid scale, dimensions, and nonfinite input', () => {
        expect(previewImagePoint(NaN, 1, geometry)).toBeNull();
        expect(previewImagePoint(1, 1, { ...geometry, scale: 0 })).toBeNull();
        expect(previewImagePoint(1, 1, { ...geometry, imageWidth: 0 })).toBeNull();
    });
});
