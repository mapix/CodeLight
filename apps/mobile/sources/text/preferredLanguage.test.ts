import { expect, it } from 'vitest';
import { resolveLanguage, resolvePreferredLanguage } from './resolveLanguage';

it('the language picker marks unsupported saved values automatic, matching the runtime device fallback', () => {
    expect(resolvePreferredLanguage('unsupported-tag')).toBeNull();
    expect(resolveLanguage('unsupported-tag', [{ languageTag: 'zh-TW' }])).toBe('zh-Hant');
    expect(resolvePreferredLanguage('zh_TW')).toBe('zh-Hant');
    expect(resolvePreferredLanguage('en-US')).toBe('en');
    expect(resolvePreferredLanguage(null)).toBeNull();
});
