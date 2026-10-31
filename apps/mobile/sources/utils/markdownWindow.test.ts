import { expect, it } from 'vitest';
import { markdownWindow } from './markdownWindow';
it('bounds initial layout, preserves complete short text and does not split UTF-16 pairs', () => {
    expect(markdownWindow('hello', 8000)).toBe('hello');
    const text = 'x'.repeat(7999) + '😀' + 'tail'.repeat(10000);
    expect(markdownWindow(text, 8000)).toBe('x'.repeat(7999));
    expect(markdownWindow(text, 16000).length).toBeLessThanOrEqual(16000);
    expect(text.endsWith('tail')).toBe(true);
});
