# CodeLight internationalization

CodeLight uses typed translation objects and the `t(key, params)` API. Static
values are strings; dynamic values are functions with typed object parameters.
No external internationalization library is required.

## Current languages

`_all.ts` registers ten languages: English (`en`), Russian (`ru`), Polish (`pl`),
Spanish (`es`), Italian (`it`), Portuguese (`pt`), Catalan (`ca`), Simplified
Chinese (`zh-Hans`), Traditional Chinese (`zh-Hant`) and Japanese (`ja`).

- `_default.ts` is the canonical English object and defines the key/parameter
  types. `translations/en.ts` retains an English mirror.
- `translations/` provides the other language objects. The language map in
  `index.ts` must include every code registered by `_all.ts`.
- `index.ts` exports `t`, `getCurrentLanguage`, and the language configuration
  helpers re-exported from `_all.ts`.
- `resolveLanguage.ts` resolves a saved preference before reading device
  locales. Script codes and regional Chinese tags such as `zh-TW` and `zh-HK`
  select Traditional Chinese. Legacy underscore tags are accepted. Unsupported
  languages or unavailable native locale lookup retain a usable English default.

## Usage

```typescript
import { t, getCurrentLanguage } from '@/text';

t('onboarding.scanButton');
t('codeLightProjects.active', { count: 2 });
t('codeLightProjects.updated', { time: '09:30' });
getCurrentLanguage();
```

Keys and parameter shapes are checked by TypeScript. If a local translation is
missing, invalid, or its formatter fails, `t` uses the canonical English value.
The internal key is returned only when no usable canonical value exists.

The current CodeLight connection, model settings, session synchronization and
project status flows have explicit translations in all ten languages. Product
descriptions identify CodeLight as a client for existing Codex desktop sessions.
Generic inherited Happy UI text outside those flows remains separate.

Project counts and their freshness come from the state owner. Translation
functions format supplied values; they do not turn unknown status into zero.
The caller supplies the localized short time string for `updated`.

## Adding or changing keys

1. Update `_default.ts` with the string or typed function.
2. Add the same keys and parameter signatures to every registered language and
   the dedicated English mirror.
3. Run mobile typecheck and targeted text tests from the repository root:

```sh
pnpm typecheck:mobile
pnpm --filter @codelight/mobile test run sources/text/resolveLanguage.test.ts sources/text/codeLightTranslations.test.ts sources/text/translationFallback.test.ts
```

The tests cover language resolution, missing/invalid translation fallback,
project counter parameters, current connection flows and Codex-only product text.
