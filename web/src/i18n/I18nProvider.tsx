import { useEffect, useState, type ReactNode } from 'react'
import { I18nContext } from './I18nContext.ts'
import { languages, messages, type Language } from './messages.ts'

const STORAGE_KEY = 'mapper.language'
const SITE_LANGUAGE_KEY = 'lang' // Shared with the portfolio and the demos

function isLanguage(value: unknown): value is Language {
  return languages.includes(value as Language)
}

/** Mapper's own choice first, then the one made on the portfolio, then the browser's (personal_web_style DECISIONS.md). */
function detectLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isLanguage(stored)) return stored
    const site = localStorage.getItem(SITE_LANGUAGE_KEY)
    if (isLanguage(site)) return site
  } catch {
    // Storage may be unavailable (private mode, blocked cookies)
  }
  const browser = navigator.language.slice(0, 2)
  return isLanguage(browser) ? browser : 'en'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(detectLanguage)

  useEffect(() => {
    document.documentElement.lang = language
    try {
      localStorage.setItem(STORAGE_KEY, language)
      localStorage.setItem(SITE_LANGUAGE_KEY, language)
    } catch {
      // Not critical: the choice just won't be remembered
    }
  }, [language])

  return <I18nContext.Provider value={{ language, setLanguage, t: messages[language] }}>{children}</I18nContext.Provider>
}
