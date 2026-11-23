import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import english from "./locale-en";
import italian from "./locale-it";
import chinese from "./locale-zh";

export type Language = "en" | "it" | "zh";
type Preference = Language | "system";
const storageKey = "sketchcraft.language";
const catalogs: Record<Language, Readonly<Record<string, string | null>>> = { en: english, it: italian, zh: chinese };

export function resolveLanguage(preference: string | null, system: string): Language {
  if (preference === "en" || preference === "it" || preference === "zh") return preference;
  if (/^it(?:-|$)/i.test(system)) return "it";
  // Traditional Chinese keeps the English UI until a zh-Hant catalog exists.
  const simplified = /^zh(?:-Hans)?(?:-|$)/i.test(system) && !/^zh-(?:Hant|TW|HK|MO)(?:-|$)/i.test(system);
  return simplified ? "zh" : "en";
}

export function translate(language: Language, id: string, fallback = id): string {
  const lookup = (catalog: typeof catalogs.en) => Object.hasOwn(catalog, id) ? catalog[id] : null;
  return lookup(catalogs[language]) ?? lookup(catalogs.en) ?? fallback;
}

function readPreference(): Preference {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "en" || saved === "it" || saved === "zh") return saved;
  } catch {}
  return "system";
}

type Locale = { language: Language; preference: Preference; setPreference: (value: string) => void; t: (id: string) => string };
const Context = createContext<Locale>({
  language: "en", preference: "system", setPreference: () => {}, t: (id) => translate("en", id),
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [preference, choose] = useState(readPreference);
  const [system, setSystem] = useState(navigator.language);
  useEffect(() => {
    const update = () => setSystem(navigator.language);
    window.addEventListener("languagechange", update);
    return () => window.removeEventListener("languagechange", update);
  }, []);
  const language = resolveLanguage(preference, system);
  useEffect(() => { document.documentElement.lang = language === "zh" ? "zh-Hans" : language; }, [language]);
  const setPreference = (value: string) => {
    if (value !== "system" && value !== "en" && value !== "it" && value !== "zh") return;
    choose(value);
    try { localStorage.setItem(storageKey, value); } catch {}
  };
  return <Context.Provider value={{ language, preference, setPreference, t: (id) => translate(language, id) }}>{children}</Context.Provider>;
}

export const useLocale = () => useContext(Context);
