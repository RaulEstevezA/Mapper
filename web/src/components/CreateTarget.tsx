import { useId, useState } from 'react'
import { DRAFT_FORMATS, type DraftFormat } from '../core/generate/models.ts'
import { findParser } from '../core/parsers/registry.ts'
import { useI18n } from '../i18n/useI18n.ts'
import './CreateTarget.css'

interface CreateTargetProps {
  sourceModel: string
  /** The target already has text: creating replaces it */
  replaces: boolean
  onCreate: (format: DraftFormat) => void
  onCancel: () => void
}

/** Form inside the Target panel to write a new target model from the source (forms stay in the page,
 * not in a modal: personal_web_style components/modals.md). */
export function CreateTarget({ sourceModel, replaces, onCreate, onCancel }: CreateTargetProps) {
  const { t } = useI18n()
  const id = useId()
  const [format, setFormat] = useState<DraftFormat>('typescript')

  return (
    <section className="create-target" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="create-target__title">
        {t.createTitle}
      </h3>
      <p className="create-target__description">{t.createDescription(sourceModel)}</p>
      <div className="create-target__row">
        <label className="field">
          <span>{t.createFormat}</span>
          <select className="select" value={format} onChange={(event) => setFormat(event.target.value as DraftFormat)}>
            {DRAFT_FORMATS.map((item) => (
              <option key={item} value={item}>
                {findParser(item)?.label ?? item}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button type="button" className="button" onClick={onCancel}>
            {t.cancel}
          </button>
          <button type="button" className="button button--primary" onClick={() => onCreate(format)}>
            {t.createConfirm}
          </button>
        </div>
      </div>
      {replaces && <p className="create-target__warning">{t.createReplace}</p>}
    </section>
  )
}
