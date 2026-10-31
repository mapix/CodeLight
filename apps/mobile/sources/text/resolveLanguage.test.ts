import { expect, it, vi } from 'vitest';
import { resolveLanguage } from './resolveLanguage';

it('honors saved language without calling the native locale getter', () => {
    const locales = vi.fn(() => [{ languageCode: 'ja' }]);
    expect(resolveLanguage('zh-Hant', locales)).toBe('zh-Hant');
    expect(resolveLanguage('pt_BR', locales)).toBe('pt');
    expect(locales).not.toHaveBeenCalled();
});

it.each([
    ['zh-TW', 'zh-Hant'], ['zh_HK', 'zh-Hant'], ['zh-MO', 'zh-Hant'],
    ['zh-Hans', 'zh-Hans'], ['zh-CN', 'zh-Hans'], ['en-US', 'en'],
])('resolves a legacy saved locale %s as %s', (saved, expected) => {
    expect(resolveLanguage(saved, [])).toBe(expected);
});

it.each([
    [{ languageCode: 'zh', languageTag: 'zh-TW' }, 'zh-Hant'],
    [{ languageCode: 'zh', regionCode: 'HK' }, 'zh-Hant'],
    [{ languageTag: 'zh-Hant' }, 'zh-Hant'],
    [{ languageCode: 'zh', languageScriptCode: 'Hant', languageTag: 'zh-CN' }, 'zh-Hant'],
    [{ languageCode: 'zh', languageScriptCode: 'Hans', languageTag: 'zh-TW' }, 'zh-Hans'],
    [{ languageCode: 'pt-BR', languageTag: 'pt-BR' }, 'pt'],
    [{ languageCode: 'pt_BR' }, 'pt'],
    [{ languageCode: 'zh_HK' }, 'zh-Hant'],
])('uses native scripts and regional locale tags: %j', (locale, expected) => {
    expect(resolveLanguage(undefined, [locale])).toBe(expected);
});

it('skips unsupported languages and retains a usable default when native locale lookup fails', () => {
    expect(resolveLanguage('fr', [{ languageCode: 'ko' }, { languageCode: 'ru' }])).toBe('ru');
    expect(resolveLanguage(undefined, () => { throw new Error('Native locale unavailable'); })).toBe('en');
    expect(resolveLanguage(null, [])).toBe('en');
});
