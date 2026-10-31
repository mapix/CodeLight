import { en, type Translations, type TranslationStructure } from './_default';
import { ru } from './translations/ru';
import { pl } from './translations/pl';
import { es } from './translations/es';
import { it } from './translations/it';
import { pt } from './translations/pt';
import { ca } from './translations/ca';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';
import { ja } from './translations/ja';
import * as Localization from 'expo-localization';
import { loadSettings } from '@/sync/persistence';
import type { SupportedLanguage } from './_all';
import { resolveLanguage } from './resolveLanguage';

/**
 * Extract all possible dot-notation keys from the nested translation object
 * E.g., 'common.cancel', 'settings.title', 'time.minutesAgo'
 */
type NestedKeys<T, Path extends string = ''> = T extends object
    ? {
        [K in keyof T]: K extends string
        ? T[K] extends string | ((...args: any[]) => string)
        ? Path extends ''
        ? K
        : `${Path}.${K}`
        : NestedKeys<T[K], Path extends '' ? K : `${Path}.${K}`>
        : never
    }[keyof T]
    : never;

/**
 * Get the value type at a specific dot-notation path
 */
type GetValue<T, Path> = Path extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T
    ? GetValue<T[Key], Rest>
    : never
    : Path extends keyof T
    ? T[Path]
    : never;

/**
 * Extract parameter type from a translation value
 * - If it's a function: extract the first parameter type
 * - If it's a string: return void (no parameters needed)
 */
type GetParams<V> =
    V extends (params: infer P) => string
    ? P
    : V extends string
    ? void
    : never;

/**
 * All valid translation keys
 */
export type TranslationKey = NestedKeys<Translations>;

/**
 * Get the parameter type for a specific translation key
 */
export type TranslationParams<K extends TranslationKey> = GetParams<GetValue<Translations, K>>;

/**
 * Re-export language types and configuration
 */
export type { SupportedLanguage } from './_all';
export { SUPPORTED_LANGUAGES, SUPPORTED_LANGUAGE_CODES, DEFAULT_LANGUAGE, getLanguageNativeName, getLanguageEnglishName } from './_all';

/**
 * Translation objects for all supported languages
 * Each language must match the exact structure of the English translations
 * All languages defined in SUPPORTED_LANGUAGES must be imported and included here
 */
const translations: Record<SupportedLanguage, TranslationStructure> = {
    en,
    ru, // TypeScript will enforce that ru matches the TranslationStructure type exactly
    pl, // TypeScript will enforce that pl matches the TranslationStructure type exactly
    es, // TypeScript will enforce that es matches the TranslationStructure type exactly
    it, // TypeScript will enforce that it matches the TranslationStructure type exactly
    pt, // TypeScript will enforce that pt matches the TranslationStructure type exactly
    ca, // TypeScript will enforce that ca matches the TranslationStructure type exactly
    'zh-Hans': zhHans, // TypeScript will enforce that zh matches the TranslationStructure type exactly
'zh-Hant': zhHant, // TypeScript will enforce that zh-Hant matches the TranslationStructure type exactly
    ja, // TypeScript will enforce that ja matches the TranslationStructure type exactly
};

// Compile-time check: ensure all supported languages have translations
const _typeCheck: Record<SupportedLanguage, TranslationStructure> = translations;

//
// Resolve language
//

const currentLanguage: SupportedLanguage = resolveLanguage(
    loadSettings().settings.preferredLanguage,
    () => Localization.getLocales(),
);

/**
 * Main translation function with strict typing
 * 
 * @param key - Dot-notation key for the translation (e.g., 'common.cancel', 'time.minutesAgo')
 * @param params - Object parameters required by the translation function (if any)
 * @returns Translated string
 * 
 * @example
 * // Simple constants (no parameters)
 * t('common.cancel')                    // "Cancel" or "Отмена"
 * t('settings.title')                   // "Settings" or "Настройки"
 * 
 * // Functions with required object parameters
 * t('codeLightProjects.active', { count: 2 })
 * t('codeLightProjects.updated', { time: '09:30' })
 * 
 * // Complex parameters
 * t('sessionInfo.agentState')           // "Agent State" or "Состояние агента"
 */
export function t<K extends TranslationKey>(
    key: K,
    ...args: GetParams<GetValue<Translations, K>> extends void
        ? []
        : [GetParams<GetValue<Translations, K>>]
): string {
    const keys = key.split('.');
    // 旧语言包缺键时曾直接显示内部 key；默认英文兜底，让局部翻译缺失仍能保持可用界面。
    const choices = [translationLeaf(translations[currentLanguage], keys), translationLeaf(en, keys)];
    for (const value of choices) {
        if (typeof value === 'string') return value;
        if (typeof value === 'function') {
            try {
                const result = value(args[0]);
                if (typeof result === 'string') return result;
            } catch { /* A faulty local formatter falls back to the English formatter. */ }
        }
    }
    return key;
}

function translationLeaf(root: unknown, keys: readonly string[]): unknown {
    let value: unknown = root;
    for (const key of keys) {
        if (typeof value !== 'object' || value === null || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}

/**
 * Get the currently active language
 * Useful for debugging and language-aware components
 */
export function getCurrentLanguage(): SupportedLanguage {
    return currentLanguage;
}
