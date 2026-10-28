import type { LanguageSupport } from '@codemirror/language'
import { useEffect, useState } from 'react'
import { generators } from '../core/generate/generators.ts'
import type { Plan } from '../core/generate/plan.ts'
import { optionValue, type CodeGenerator, type GeneratedCode, type GenerateSettings, type NamingMode } from '../core/generate/types.ts'
import { useI18n } from '../i18n/useI18n.ts'
import { downloadBlob } from '../utils/download.ts'
import { editorLanguage } from '../utils/editorLanguages.ts'
import { createZip } from '../utils/zip.ts'
import { CodeEditor } from './CodeEditor.tsx'
import { Pane } from './Pane.tsx'
import './CodePanel.css'

const NAMINGS: NamingMode[] = ['auto', 'keep', 'convention']

interface CodePanelProps {
  generator: CodeGenerator
  settings: GenerateSettings
  plan: Plan | null
  output: GeneratedCode | null
  onGeneratorChange: (id: string) => void
  onSettingsChange: (settings: GenerateSettings) => void
}

export function CodePanel({ generator, settings, plan, output, onGeneratorChange, onSettingsChange }: CodePanelProps) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [selected, setSelected] = useState(0)
  const [language, setLanguage] = useState<LanguageSupport | null>(null)
  const files = output?.files ?? []
  const file = files[Math.min(selected, files.length - 1)] ?? null
  const notes = output?.notes ?? []

  useEffect(() => {
    let active = true
    void editorLanguage(generator.editorLanguage).then((loaded) => {
      if (active) setLanguage(loaded)
    })
    return () => {
      active = false
    }
  }, [generator.editorLanguage])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    if (!file) return
    try {
      await navigator.clipboard.writeText(file.code)
      setCopied(true)
    } catch {
      // Clipboard blocked (permissions, insecure context): the code can still be selected by hand
    }
  }

  function download() {
    if (files.length === 1) downloadBlob(new Blob([files[0].code], { type: 'text/plain;charset=utf-8' }), files[0].name)
    else if (files.length > 1)
      downloadBlob(
        new Blob([createZip(files.map((item) => ({ name: item.name, content: item.code })))], { type: 'application/zip' }),
        `mapper-${generator.id}.zip`,
      )
  }

  const setOption = (id: string, value: string) => onSettingsChange({ ...settings, options: { ...settings.options, [id]: value } })

  return (
    <Pane
      title={t.codeTitle}
      actions={
        <label className="code-panel__language">
          <span className="visually-hidden">{t.codeLanguage}</span>
          <select className="select" value={generator.id} onChange={(event) => onGeneratorChange(event.target.value)}>
            {generators.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      }
      footer={
        <div className="code-panel__footer">
          <div className="code-panel__info">
            {file && <span className="code-panel__file">{file.name}</span>}
            {notes.length > 0 && (
              <details className="code-panel__notes">
                <summary>{t.notesCount(notes.length)}</summary>
                <ul>
                  {notes.map((note, index) => (
                    <li key={`${note.code}-${index}`}>{t.note(note)}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          <div className="actions">
            <button type="button" className="button" onClick={copy} disabled={!file}>
              {copied ? t.copied : t.copy}
            </button>
            <button type="button" className="button button--primary" onClick={download} disabled={files.length === 0}>
              {files.length > 1 ? t.downloadZip(files.length) : t.download}
            </button>
          </div>
        </div>
      }
    >
      <div className="code-panel">
        <div className="code-panel__settings">
          {generator.modes.length > 1 && (
            <label className="field">
              <span>{t.codeMode}</span>
              <select
                className="select"
                value={settings.mode}
                onChange={(event) => onSettingsChange({ ...settings, mode: event.target.value })}
              >
                {generator.modes.map((mode) => (
                  <option key={mode} value={mode}>
                    {t.modes[mode] ?? mode}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>{t.namingLabel}</span>
            <select
              className="select"
              value={settings.naming}
              onChange={(event) => onSettingsChange({ ...settings, naming: event.target.value as NamingMode })}
            >
              {NAMINGS.map((naming) => (
                <option key={naming} value={naming}>
                  {t.namings[naming]}
                </option>
              ))}
            </select>
          </label>
          {generator.options
            .filter((option) => option.id !== 'componentModel' || settings.mode === 'mapstruct')
            .map((option) => {
              const value = optionValue(generator, plan, settings, option.id)
              return (
                <label key={option.id} className="field">
                  <span>{t.optionLabels[option.id] ?? option.id}</span>
                  {option.kind === 'text' ? (
                    <input
                      className="input input--mono"
                      value={value}
                      spellCheck={false}
                      onChange={(event) => setOption(option.id, event.target.value)}
                    />
                  ) : (
                    <select className="select" value={value} onChange={(event) => setOption(option.id, event.target.value)}>
                      {option.choices.map((choice) => (
                        <option key={choice} value={choice}>
                          {t.choiceLabels[choice] ?? choice}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              )
            })}
        </div>
        {files.length > 1 && (
          <div className="code-panel__files" role="tablist" aria-label={t.files}>
            {files.map((item, index) => (
              <button
                key={item.name}
                type="button"
                role="tab"
                aria-selected={item === file}
                className="code-panel__file-tab"
                onClick={() => setSelected(index)}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}
        <div className="code-panel__editor">
          <CodeEditor
            value={file?.code ?? ''}
            language={language}
            readOnly
            label={t.codeLabel(generator.label)}
            placeholder={t.codeEmpty}
          />
        </div>
      </div>
    </Pane>
  )
}
