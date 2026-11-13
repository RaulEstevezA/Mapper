import { useEffect, useState, type ReactNode } from 'react'
import { detectLanguage, SITE_LANGUAGE_KEY } from './detectLanguage.ts'
import { I18nContext } from './I18nContext.ts'
import { messages, type Language } from './messages.ts'

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() =>
    detectLanguage(() => localStorage.getItem(SITE_LANGUAGE_KEY), navigator.language),
  )

  /** Changes the interface language with the same page fade as the portfolio. */
  function setLanguage(next: Language) {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (!document.startViewTransition || reduceMotion) {
      setLanguageState(next)
      return
    }
    document.startViewTransition(() => setLanguageState(next))
  }

  useEffect(() => {
    document.documentElement.lang = language
    try {
      localStorage.setItem(SITE_LANGUAGE_KEY, language)
    } catch {
      // Not critical: the choice just won't be remembered
    }
  }, [language])

  return <I18nContext.Provider value={{ language, setLanguage, t: messages[language] }}>{children}</I18nContext.Provider>
}
