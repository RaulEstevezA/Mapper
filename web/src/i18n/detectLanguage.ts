import { languages, type Language } from './messages.ts'

/** The one language of the whole website: portfolio, tools, demos and games share this key. */
export const SITE_LANGUAGE_KEY = 'lang'

function isLanguage(value: unknown): value is Language {
  return languages.includes(value as Language)
}

/**
 * The inherited language first, then the browser's, then English
 * (personal_web_style DECISIONS.md, "Clave del idioma guardado").
 */
export function detectLanguage(readInherited: () => string | null, browserLanguage: string): Language {
  try {
    const inherited = readInherited()
    if (isLanguage(inherited)) return inherited
  } catch {
    // Storage may be unavailable (private mode, blocked cookies)
  }
  const browser = browserLanguage.slice(0, 2)
  return isLanguage(browser) ? browser : 'en'
}
