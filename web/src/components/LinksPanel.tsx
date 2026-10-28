import { useI18n } from '../i18n/useI18n.ts'
import { API2CLASS_URL, SOURCE_URL, TOOLS_URL } from '../utils/links.ts'
import './LinksPanel.css'

/** Card under the workspace: source code, the other tools and where to start from a JSON response. */
export function LinksPanel() {
  const { t } = useI18n()

  return (
    <section className="links window">
      <div className="actions">
        <a className="button" href={SOURCE_URL} target="_blank" rel="noopener">
          {t.introCode}
        </a>
        <a className="button" href={TOOLS_URL}>
          {t.introAllTools}
        </a>
      </div>
      <p className="links__note">
        {t.api2classNote} <a href={API2CLASS_URL}>{t.api2classLink}</a>
      </p>
    </section>
  )
}
