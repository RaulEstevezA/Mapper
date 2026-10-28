import type { LanguageSupport } from '@codemirror/language'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { acceptedExtensions, detectFormat, findParser, parsers } from '../core/parsers/registry.ts'
import type { InputFormatId } from '../core/parsers/types.ts'
import type { InputState, ReadInput } from '../app/workspace.ts'
import { useI18n } from '../i18n/useI18n.ts'
import { editorLanguage } from '../utils/editorLanguages.ts'
import type { DraftFormat } from '../core/generate/models.ts'
import { CodeEditor } from './CodeEditor.tsx'
import { CreateTarget } from './CreateTarget.tsx'
import { Pane } from './Pane.tsx'
import './InputPane.css'

// Far above any model or example document; avoids freezing the tab with a huge file dropped by mistake
const MAX_FILE_SIZE = 10 * 1024 * 1024

interface InputPaneProps {
  role: 'source' | 'target'
  input: InputState
  read: ReadInput
  onChange: (input: InputState) => void
  /** Target only: writing a new model from the source (null while the source cannot be read) */
  create?: { sourceModel: string | null; onCreate: (format: DraftFormat) => void }
}

export function InputPane({ role, input, read, onChange, create }: InputPaneProps) {
  const { t } = useI18n()
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [language, setLanguage] = useState<LanguageSupport | null>(null)
  const format = read.format
  const parser = format ? findParser(format) : undefined
  const detected = input.text.trim() !== '' ? detectFormat(input.text, input.fileName) : null
  const outcome = read.outcome
  const id = `${role}-input`

  useEffect(() => {
    let active = true
    void editorLanguage(parser?.editorLanguage ?? 'text').then((loaded) => {
      if (active) setLanguage(loaded)
    })
    return () => {
      active = false
    }
  }, [parser?.editorLanguage])

  function change(next: Partial<InputState>) {
    setFileError(null)
    onChange({ ...input, ...next })
  }

  /** Read in the browser: the file is never uploaded. */
  async function openFile(file: File) {
    if (file.size > MAX_FILE_SIZE) {
      setFileError(t.fileTooLarge(file.name))
      return
    }
    try {
      const text = await file.text()
      onChange({ text, format: null, model: null, fileName: file.name })
      setFileError(null)
    } catch {
      setFileError(t.fileError(file.name))
    }
  }

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')
  const models = outcome?.ok ? outcome.schema.models : []
  const fieldCount = models.reduce((total, model) => total + model.fields.length, 0)
  const title = role === 'source' ? t.sourceTitle : t.targetTitle

  let status: React.ReactNode
  if (fileError) {
    status = (
      <p className="input-status input-status--error" role="alert">
        {fileError}
      </p>
    )
  } else if (input.text.trim() === '') {
    status = <p className="input-status">{t.inputEmpty}</p>
  } else if (!format) {
    status = (
      <p className="input-status input-status--warning" role="alert">
        {t.undetected}
      </p>
    )
  } else if (outcome && !outcome.ok) {
    const { error } = outcome
    status = (
      <p className="input-status input-status--error" role="alert">
        {error.line !== undefined && <strong>{t.errorPosition(error.line, error.column ?? 1)} · </strong>}
        {t.parseIssue(error)}
      </p>
    )
  } else if (outcome?.ok) {
    status = (
      <p className="input-status input-status--ok">
        {input.receivedFrom && <span className="input-status__received">{t.receivedFrom(input.receivedFrom)} </span>}
        {t.inputSummary(parser?.label ?? format, models.length, fieldCount)}
        {outcome.warnings.length > 0 && (
          <span className="input-status__warnings" title={outcome.warnings.map((warning) => t.parseIssue(warning)).join('\n')}>
            {' · '}
            {t.warningsCount(outcome.warnings.length)}
          </span>
        )}
      </p>
    )
  }

  return (
    <div
      className={`input-pane${dragging ? ' input-pane--dragging' : ''}`}
      onDragOver={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDropCapture={(event) => {
        if (!hasFiles(event)) return
        // Captured before CodeMirror, which would otherwise insert the file as text
        event.preventDefault()
        event.stopPropagation()
        setDragging(false)
        const file = event.dataTransfer.files[0]
        if (file) void openFile(file)
      }}
    >
      <Pane
        title={title}
        actions={
          <>
            <button type="button" className="button" onClick={() => fileInput.current?.click()}>
              {t.openFile}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => change({ text: '', format: null, model: null, fileName: undefined, receivedFrom: undefined })}
              disabled={input.text === ''}
            >
              {t.clear}
            </button>
            {create && (
              <button
                type="button"
                className="button"
                aria-expanded={creating}
                disabled={!create.sourceModel}
                title={create.sourceModel ? undefined : t.createUnavailable}
                onClick={() => setCreating(!creating)}
              >
                {t.create}
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept={acceptedExtensions().join(',')}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void openFile(file)
              }}
            />
          </>
        }
        footer={status}
      >
        {create && creating && create.sourceModel && (
          <CreateTarget
            sourceModel={create.sourceModel}
            replaces={input.text.trim() !== ''}
            onCreate={(format) => {
              create.onCreate(format)
              setCreating(false)
            }}
            onCancel={() => setCreating(false)}
          />
        )}
        <div className="input-pane__settings">
          <label className="field">
            <span>{t.formatLabel}</span>
            <select
              className="select"
              value={input.format ?? ''}
              onChange={(event) => change({ format: (event.target.value || null) as InputFormatId | null, model: null })}
            >
              <option value="">{t.formatAuto(detected ? (findParser(detected)?.label ?? detected) : null)}</option>
              {parsers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {models.length > 1 && (
            <label className="field">
              <span>{t.modelLabel}</span>
              <select className="select" value={read.model ?? ''} onChange={(event) => change({ model: event.target.value })}>
                {models.map((model) => (
                  <option key={model.name} value={model.name}>
                    {model.name} ({model.fields.length})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="input-pane__editor" id={id}>
          <CodeEditor
            value={input.text}
            onChange={(text) => change({ text, receivedFrom: undefined })}
            language={language}
            label={role === 'source' ? t.sourceLabel : t.targetLabel}
            placeholder={t.inputPlaceholder}
            errorLine={outcome && !outcome.ok && outcome.error.line !== undefined ? outcome.error.line : null}
          />
          {dragging && <div className="input-pane__drop">{t.dropFile}</div>}
        </div>
      </Pane>
    </div>
  )
}
