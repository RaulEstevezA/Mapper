import { useI18n } from '../i18n/useI18n.ts'
import { SOURCE_URL } from '../utils/links.ts'
import './AppFooter.css'

export function AppFooter() {
  const { t } = useI18n()

  return (
    <footer className="app-footer">
      <span>{t.license}</span>
      <a href={SOURCE_URL} target="_blank" rel="noopener">
        {t.sourceCode}
      </a>
      <a href="https://raulesteveza.github.io/">Raúl Estévez</a>
    </footer>
  )
}
