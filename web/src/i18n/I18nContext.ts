import { createContext } from 'react'
import type { Language, Messages } from './messages.ts'

export interface I18nValue {
  language: Language
  setLanguage: (language: Language) => void
  t: Messages
}

export const I18nContext = createContext<I18nValue | null>(null)
