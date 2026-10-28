import type { Confidence } from '../core/mapping/types.ts'
import { useI18n } from '../i18n/useI18n.ts'

const VARIANT: Record<Confidence | 'manual' | 'ignored', string> = {
  exact: 'badge--success',
  high: 'badge--success',
  probable: 'badge--accent',
  review: 'badge--warning',
  conflict: 'badge--warning',
  none: '',
  manual: 'badge--accent',
  ignored: '',
}

/** State of a relation as text with a color (patterns/confidence-states.md): never color alone. The
 * score is shown for suggestions that are not certain. */
export function ConfidenceBadge({
  confidence,
  score,
  title,
}: {
  confidence: Confidence | 'manual' | 'ignored'
  score?: number
  title?: string
}) {
  const { t } = useI18n()
  const label = t.status[confidence]
  const withScore = score !== undefined && (confidence === 'probable' || confidence === 'review') ? t.statusWithScore(label, score) : label
  return (
    <span className={`badge ${VARIANT[confidence]}`} title={title}>
      {withScore}
    </span>
  )
}
