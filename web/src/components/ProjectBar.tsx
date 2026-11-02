import { useRef } from 'react'
import { useI18n } from '../i18n/useI18n.ts'
import './ProjectBar.css'

interface ProjectBarProps {
  canSave: boolean
  canExportTarget: boolean
  remember: boolean
  hasSaved: boolean
  message: { text: string; kind: 'ok' | 'error' } | null
  onSave: () => void
  onOpen: (file: File) => void
  onExportTarget: () => void
  onRememberChange: (remember: boolean) => void
  onClearSaved: () => void
}

/** Saving and opening projects, and the opt-in to keep the work in this browser. */
export function ProjectBar({
  canSave,
  canExportTarget,
  remember,
  hasSaved,
  message,
  onSave,
  onOpen,
  onExportTarget,
  onRememberChange,
  onClearSaved,
}: ProjectBarProps) {
  const { t } = useI18n()
  const fileInput = useRef<HTMLInputElement>(null)

  return (
    <section className="project-bar panel" aria-label={t.projectActions}>
      <div className="actions">
        <button type="button" className="button" onClick={() => fileInput.current?.click()}>
          {t.openProject}
        </button>
        <button type="button" className="button" onClick={onSave} disabled={!canSave}>
          {t.saveProject}
        </button>
        <button type="button" className="button" onClick={onExportTarget} disabled={!canExportTarget} title={t.exportTargetTitle}>
          {t.exportTarget}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) onOpen(file)
          }}
        />
      </div>
      <div className="project-bar__storage">
        <label className="project-bar__remember" title={t.rememberHint}>
          <input type="checkbox" checked={remember} onChange={(event) => onRememberChange(event.target.checked)} />
          {t.remember}
        </label>
        {hasSaved && (
          <button
            type="button"
            className="button button--small"
            onClick={() => {
              if (window.confirm(t.clearSavedConfirm)) onClearSaved()
            }}
          >
            {t.clearSaved}
          </button>
        )}
      </div>
      {message && (
        <p className={`project-bar__message project-bar__message--${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </section>
  )
}
