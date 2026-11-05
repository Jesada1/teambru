"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  translate,
  type Lang,
  type TranslateVars,
  type TranslationKey,
} from "../lib/i18n";

type LanguageContextValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  t: (key: TranslationKey, vars?: TranslateVars) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

const STORAGE_KEY = "teambru.lang";

export function LanguageProvider({ children }: { children: ReactNode }) {
  // Always start with "th" so SSR + first client paint match (no hydration mismatch)
  const [lang, setLangState] = useState<Lang>("th");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "th" || stored === "en") setLangState(stored);
    } catch {
      /* ignore */
    }
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleLang = useCallback(() => {
    setLang(lang === "th" ? "en" : "th");
  }, [lang, setLang]);

  const t = useCallback(
    (key: TranslationKey, vars?: TranslateVars) => translate(lang, key, vars),
    [lang]
  );

  const value = useMemo(
    () => ({ lang, setLang, toggleLang, t }),
    [lang, setLang, toggleLang, t]
  );

  return (
    <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error("useLanguage must be used within LanguageProvider");
  }
  return ctx;
}

/** Compact TH | EN segmented control for the sticky navbar */
export function LanguageSwitcher() {
  const { lang, setLang, t } = useLanguage();

  return (
    <div
      role="group"
      aria-label={t("app.langAria")}
      className="inline-flex rounded-md border border-zinc-200/80 bg-zinc-50 p-0.5"
    >
      {(["th", "en"] as const).map((code) => {
        const active = lang === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => setLang(code)}
            className={
              active
                ? "rounded-md bg-zinc-900 px-2.5 py-1 text-[11px] font-bold tracking-wide text-white shadow-sm transition-all duration-150 active:scale-[0.98]"
                : "rounded-md px-2.5 py-1 text-[11px] font-bold tracking-wide text-zinc-500 transition-all duration-150 hover:text-zinc-900 active:scale-[0.98]"
            }
          >
            {code.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
