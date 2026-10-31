import { afterEach, expect, it, vi } from 'vitest';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'ja' }] }));
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: { preferredLanguage: 'ja' } }) }));

import { en } from './_default';
import { ja } from './translations/ja';
import { getCurrentLanguage, t } from './index';

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

function replace(object: object, key: string, value: unknown) {
    const target = object as Record<string, unknown>;
    const previous = target[key];
    restores.push(() => { target[key] = previous; });
    if (value === undefined) delete target[key];
    else target[key] = value;
}

it('uses the saved language and formats local project counts', () => {
    expect(getCurrentLanguage()).toBe('ja');
    expect(t('codeLightProjects.waiting', { count: 4 })).toBe(ja.codeLightProjects.waiting({ count: 4 }));
});

it('falls back to English for a missing leaf or group instead of displaying an internal key', () => {
    replace(ja.codeLightModels, 'check', undefined);
    replace(ja, 'sourceBridge', undefined);
    expect(t('codeLightModels.check')).toBe(en.codeLightModels.check);
    expect(t('sourceBridge.waiting')).toBe(en.sourceBridge.waiting);
});

it('falls back to the English formatter while preserving its supplied count', () => {
    replace(ja.codeLightProjects, 'active', () => { throw new Error('Invalid local formatter'); });
    expect(t('codeLightProjects.active', { count: 7 })).toBe(en.codeLightProjects.active({ count: 7 }));
});

it('falls back for an invalid local translation value', () => {
    replace(ja.codeLightModels, 'check', 42);
    expect(t('codeLightModels.check')).toBe(en.codeLightModels.check);
});
