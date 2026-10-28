import { useI18n } from '../i18n/useI18n.ts'
import { languages } from '../i18n/messages.ts'
import './LanguageSwitcher.css'

export function LanguageSwitcher() {
  const { language, setLanguage, t } = useI18n()

  return (
    <div className="language-switcher" role="group" aria-label={t.languageLabel}>
      {languages.map((code) => (
        <button
          key={code}
          type="button"
          className="language-switcher__option"
          aria-pressed={code === language}
          onClick={() => setLanguage(code)}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
