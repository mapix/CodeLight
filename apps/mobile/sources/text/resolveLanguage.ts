import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, type SupportedLanguage } from './_all';

type LocaleLanguage = {
    languageCode?: string | null;
    languageScriptCode?: string | null;
    languageTag?: string;
    regionCode?: string | null;
};

function isSupportedLanguage(value: string): value is SupportedLanguage {
    return Object.prototype.hasOwnProperty.call(SUPPORTED_LANGUAGES, value);
}

function languageFromLocale(locale: LocaleLanguage): SupportedLanguage | null {
    const tag = (locale.languageTag ?? locale.languageCode ?? '').replace(/_/g, '-');
    const language = (locale.languageCode || tag).replace(/_/g, '-').split('-')[0].toLowerCase();
    if (language === 'zh') {
        const script = locale.languageScriptCode || tag.match(/-(Hans|Hant)(?:-|$)/i)?.[1];
        if (script?.toLowerCase() === 'hant') return 'zh-Hant';
        if (script?.toLowerCase() === 'hans') return 'zh-Hans';
        // 部分系统仅返回 zh-TW/zh-HK 地区标签；不能把已支持的繁体中文误判成简体。
        const region = locale.regionCode || tag.match(/-(TW|HK|MO|CN|SG)(?:-|$)/i)?.[1];
        return /^(TW|HK|MO)$/i.test(region ?? '') ? 'zh-Hant' : 'zh-Hans';
    }
    return isSupportedLanguage(language) ? language : null;
}

/** Resolve saved preferences first; native locale access is lazy and can be unavailable on web. */
export function resolvePreferredLanguage(preferred: unknown): SupportedLanguage | null {
    if (typeof preferred !== 'string') return null;
    const tag = preferred.trim().replace(/_/g, '-');
    return isSupportedLanguage(tag) ? tag : languageFromLocale({ languageTag: tag });
}

export function resolveLanguage(
    preferred: unknown,
    locales: readonly LocaleLanguage[] | (() => readonly LocaleLanguage[]),
): SupportedLanguage {
    const saved = resolvePreferredLanguage(preferred);
    if (saved) return saved;
    try {
        const deviceLocales = typeof locales === 'function' ? locales() : locales;
        for (const locale of deviceLocales) {
            const language = languageFromLocale(locale);
            if (language) return language;
        }
    } catch { /* Device locale lookup is optional; the default language remains usable. */ }
    return DEFAULT_LANGUAGE;
}
