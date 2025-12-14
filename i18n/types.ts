
export type Locale = 'en' | 'fr';

export type TranslationParams = Record<string, string | number>;

export interface I18nContextType {
  locale: Locale;
  setLocale: (lang: Locale) => void;
  t: (key: string, params?: TranslationParams & { defaultValue?: string }) => string;
}
