
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Locale, TranslationParams, I18nContextType } from './types';
import { en } from './locales/en';
import { fr } from './locales/fr';

const translations: Record<Locale, Record<string, string>> = { en, fr };

const I18nContext = createContext<I18nContextType | undefined>(undefined);

const STORAGE_KEY = 'stellar_fleet_lang';

const isDomAvailable =
  typeof window !== 'undefined' &&
  typeof document !== 'undefined' &&
  typeof navigator !== 'undefined';

const safeGetStorage = (key: string): string | null => {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn('[i18n] Failed to read from storage', error);
    return null;
  }
};

const safeSetStorage = (key: string, value: string) => {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn('[i18n] Failed to write to storage', error);
  }
};

const getInitialLocale = (): Locale => {
  const saved = safeGetStorage(STORAGE_KEY);
  if (saved === 'en' || saved === 'fr') return saved;

  if (isDomAvailable) {
    const nav = navigator.language?.split('-')[0];
    if (nav === 'fr') return 'fr';
  }

  return 'en';
};

export const I18nProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<Locale>(() => getInitialLocale());

  const setLocale = (lang: Locale) => {
    setLocaleState(lang);
    safeSetStorage(STORAGE_KEY, lang);
    if (isDomAvailable) {
      document.documentElement.lang = lang;
    }
  };

  // Sync html lang on mount
  useEffect(() => {
    if (isDomAvailable) {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const t = (key: string, params?: TranslationParams & { defaultValue?: string }): string => {
    let text = translations[locale][key] || params?.defaultValue || key;

    // Pluralization simple (key + '_one' or '_other')
    // Check if params.count is present
    if (params && typeof params.count === 'number') {
      const suffix = params.count === 1 ? '_one' : '_other';
      const pluralKey = key + suffix;
      if (translations[locale][pluralKey]) {
        text = translations[locale][pluralKey];
      }
    }

    // Interpolation {{key}}
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        text = text.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
      });
    }

    return text;
  };

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export const useI18n = (): I18nContextType => {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
};

// Exported for testing SSR-safe initialization
export { getInitialLocale };
