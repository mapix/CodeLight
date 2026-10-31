import { describe, expect, it } from 'vitest';
import { attachmentImageScope } from './attachmentImageScope';
describe('attachment image source binding', () => {
    it('separates a repeated ref across source, server and account', () => {
        const key = attachmentImageScope('http://loopback:1', 'account-a', 'source-a', 'ref-a');
        expect(key).not.toBe(attachmentImageScope('http://loopback:1', 'account-a', 'source-b', 'ref-a'));
        expect(key).not.toBe(attachmentImageScope('http://loopback:2', 'account-a', 'source-a', 'ref-a'));
        expect(key).not.toBe(attachmentImageScope('http://loopback:1', 'account-b', 'source-a', 'ref-a'));
    });
    it('does not expose cache identity without current credentials or source', () => {
        expect(attachmentImageScope('http://loopback:1', null, 'source-a', 'ref-a')).toBeNull();
        expect(attachmentImageScope('http://loopback:1', 'account-a', '', 'ref-a')).toBeNull();
    });
});
