import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/useI18n.ts'
import {
  detectArchitecture,
  detectPlatform,
  downloadUrl,
  hasArchitectureChoice,
  RELEASES_URL,
  type Architecture,
} from '../utils/desktopDownload.ts'
import { API2CLASS_URL, SOURCE_URL, TOOLS_URL } from '../utils/links.ts'
import './LinksPanel.css'

const platform = detectPlatform(navigator)
const ARCHITECTURE_NAMES: Record<Architecture, string> = { x64: 'x64', arm64: 'ARM64' }

/** Card under the workspace: desktop download for the visitor's system, source code, the other tools and
 * where to start from a JSON response. */
export function LinksPanel() {
  const { t } = useI18n()
  // x64 until the browser says otherwise; the note always links the other one in case it guessed wrong
  const [architecture, setArchitecture] = useState<Architecture>('x64')
  const choice = platform !== null && hasArchitectureChoice(platform)
  const otherArchitecture: Architecture = architecture === 'x64' ? 'arm64' : 'x64'

  useEffect(() => {
    if (!choice) return
    let active = true
    void detectArchitecture(navigator).then((detected) => {
      if (active && detected) setArchitecture(detected)
    })
    return () => {
      active = false
    }
  }, [choice])

  return (
    <section className="links window">
      <div className="actions">
        {platform ? (
          <a className="button" href={downloadUrl(platform, architecture)}>
            {t.downloadFor(architecture === 'arm64' && choice ? `${platform} ${ARCHITECTURE_NAMES.arm64}` : platform)}
          </a>
        ) : (
          <a className="button" href={RELEASES_URL} target="_blank" rel="noopener">
            {t.downloadDesktop}
          </a>
        )}
        <a className="button" href={SOURCE_URL} target="_blank" rel="noopener">
          {t.introCode}
        </a>
        <a className="button" href={TOOLS_URL}>
          {t.introAllTools}
        </a>
      </div>
      <p className="links__note">
        {t.downloadNote}{' '}
        <a href={t.howToOpenUrl} target="_blank" rel="noopener">
          {t.howToOpen}
        </a>
        {platform && choice && (
          <>
            {' · '}
            <a href={downloadUrl(platform, otherArchitecture)}>{t.otherArchitecture(ARCHITECTURE_NAMES[otherArchitecture])}</a>
          </>
        )}
        {platform && (
          <>
            {' · '}
            <a href={RELEASES_URL} target="_blank" rel="noopener">
              {t.otherPlatforms}
            </a>
          </>
        )}
      </p>
      <p className="links__note">
        {t.api2classNote} <a href={API2CLASS_URL}>{t.api2classLink}</a>
      </p>
    </section>
  )
}
