import { expect, it } from 'vitest';
import { messageWindowEnd } from './messageWindow';
import type { Message } from '@/sync/typesMessage';
it('bounds initial processing for a 10,000-row turn while letting the reader grow the window', () => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), kind: 'agent-text', text: 'work', createdAt: i })) as Message[];
    expect(messageWindowEnd(rows, 60, true)).toBe(120);
    expect(messageWindowEnd(rows, 180, true)).toBe(240);
    expect(messageWindowEnd(rows, 60, false)).toBe(10000);
});
it('keeps a nearby accepted user prompt as the turn boundary', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: String(i), kind: i === 79 ? 'user-text' : 'agent-text', text: 'work', createdAt: i })) as Message[];
    expect(messageWindowEnd(rows, 60, true)).toBe(80);
});
