import { expect, it } from 'vitest';
import { en, type TranslationStructure } from './_default';
import { en as dedicatedEn } from './translations/en';
import { ru } from './translations/ru';
import { pl } from './translations/pl';
import { es } from './translations/es';
import { it as italian } from './translations/it';
import { pt } from './translations/pt';
import { ca } from './translations/ca';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';
import { ja } from './translations/ja';
import { SUPPORTED_LANGUAGE_CODES, type SupportedLanguage } from './_all';

const translations: Record<SupportedLanguage, TranslationStructure> = {
    en, ru, pl, es, it: italian, pt, ca, 'zh-Hans': zhHans, 'zh-Hant': zhHant, ja,
};
const visibleGroups = ['codeLightSetup', 'codeLightPairing', 'codeLightModels', 'codeLightLoading', 'codeLightSessionStatus', 'sourceBridge'] as const;
const scanKeys = ['linkTitle', 'openBody', 'scanButton', 'linking', 'pasteLink', 'pasteLinkTitle', 'pasteLinkMessage', 'pasteLinkConfirm'] as const;

it.each(SUPPORTED_LANGUAGE_CODES)('%s provides all project counters and explicit current CodeLight flow translations', (language) => {
    const translation = translations[language];
    expect(Object.keys(translation.codeLightSessionStatus).sort()).toEqual(['active', 'idle', 'unknown', 'waiting']);
    for (const key of ['active', 'waiting', 'idle', 'unknown'] as const) {
        const label = translation.codeLightSessionStatus[key];
        expect(typeof label).toBe('string');
        expect(label.trim().length).toBeGreaterThan(0);
        expect(label).not.toContain('\n');
        if (language !== 'en') expect(label).not.toBe(en.codeLightSessionStatus[key]);
    }
    expect(Object.keys(translation.codeLightProjects).sort()).toEqual(Object.keys(en.codeLightProjects).sort());
    for (const count of [0, 1, 12]) {
        for (const key of ['active', 'waiting', 'unknown', 'total'] as const) {
            const text = translation.codeLightProjects[key]({ count });
            expect(text).toContain(String(count));
            expect(text).not.toContain('{count}');
        }
    }
    expect(translation.codeLightProjects.updated({ time: '09:30' })).toContain('09:30');
    for (const key of ['offline', 'stale', 'refreshing', 'unavailable'] as const) expect(translation.codeLightProjects[key].length).toBeGreaterThan(0);
    for (const key of scanKeys) {
        expect(translation.onboarding[key].length).toBeGreaterThan(0);
        if (language !== 'en') expect(translation.onboarding[key]).not.toBe(en.onboarding[key]);
    }
    if (language !== 'en') {
        for (const group of visibleGroups) expect(JSON.stringify(translation[group])).not.toBe(JSON.stringify(en[group]));
    }
    expect(translation.settings.aboutFooter).toContain('Codex');
    expect(translation.settings.aboutFooter).not.toMatch(/Claude|Anthropic/);
    expect(translation.welcome.title).toContain('Codex');
    expect(translation.welcome.title).not.toContain('Claude');
    expect(translation.codeLightSetup.helpBody).not.toContain('start-codelight.sh');
    expect(translation.onboarding.terminalRun).toBe('open /Applications/CodeLight.app');
});

it('keeps the dedicated English mirror in sync for current CodeLight features', () => {
    for (const group of visibleGroups) expect(JSON.stringify(dedicatedEn[group])).toBe(JSON.stringify(en[group]));
    expect(dedicatedEn.codeLightProjects.updated({ time: '09:30' })).toBe(en.codeLightProjects.updated({ time: '09:30' }));
    expect(dedicatedEn.settings.aboutFooter).toBe(en.settings.aboutFooter);
});

it('uses the specified Chinese session status labels without inferring idle from unknown', () => {
    expect(zhHans.codeLightSessionStatus).toEqual({ active: '活跃', waiting: '待操作', idle: '空闲', unknown: '未确认' });
    expect(zhHant.codeLightSessionStatus).toEqual({ active: '活躍', waiting: '待操作', idle: '空閒', unknown: '未確認' });
});
