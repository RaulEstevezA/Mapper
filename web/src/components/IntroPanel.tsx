import { EXAMPLES, type ExampleId } from '../examples/index.ts'
import { useI18n } from '../i18n/useI18n.ts'
import './IntroPanel.css'

/** Presentation of the tool, styled like the portfolio's windows, with the examples to start from. */
export function IntroPanel({ onExample }: { onExample: (id: ExampleId) => void }) {
  const { t } = useI18n()

  return (
    <section className="intro window" aria-labelledby="intro-title">
      <div className="intro__text">
        <div className="intro__title">
          <h1 id="intro-title">Mapper</h1>
          <span className="intro__badge">{t.privacyShort}</span>
        </div>
        <p className="intro__subtitle">{t.tagline}</p>
        <p className="intro__description">{t.introDescription}</p>
      </div>
      <div className="intro__side">
        <ul className="intro__privacy" role="note">
          {t.privacyPoints.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <div className="intro__examples" role="group" aria-labelledby="examples-label">
          <span id="examples-label" className="intro__examples-label">
            {t.examplesLabel}
          </span>
          <div className="intro__example-list">
            {EXAMPLES.map((example) => (
              <button
                key={example.id}
                type="button"
                className="button button--small"
                title={t.exampleDescriptions[example.id]}
                onClick={() => onExample(example.id)}
              >
                {t.examples[example.id]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
