import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { EMPTY_INPUT, readInput, reconcile, summarize, type InputState } from './app/workspace.ts'
import { findGenerator } from './core/generate/generators.ts'
import { draftTarget, type DraftFormat } from './core/generate/models.ts'
import { buildPlan } from './core/generate/plan.ts'
import type { GenerateSettings, NamingMode } from './core/generate/types.ts'
import type { MappingSet } from './core/mapping/types.ts'
import { validateMapping } from './core/mapping/validate.ts'
import { MODEL_SCHEMA_FORMAT } from './core/model/schema.ts'
import { isTrustedOrigin, readHandoff, takeIncoming, type Handoff } from './core/project/handoff.ts'
import { findParser } from './core/parsers/registry.ts'
import type { InputFormatId } from './core/parsers/types.ts'
import { createProject, projectFileName, readProject, type MapperProject } from './core/project/project.ts'
import { findExample, type ExampleId } from './examples/index.ts'
import { AppFooter } from './components/AppFooter.tsx'
import { AppHeader } from './components/AppHeader.tsx'
import { CodePanel } from './components/CodePanel.tsx'
import { InputPane } from './components/InputPane.tsx'
import { IntroPanel } from './components/IntroPanel.tsx'
import { LinksPanel } from './components/LinksPanel.tsx'
import { MappingPanel } from './components/MappingPanel.tsx'
import { ProjectBar } from './components/ProjectBar.tsx'
import { useHistory } from './hooks/useHistory.ts'
import { useStoredState } from './hooks/useStoredState.ts'
import { useI18n } from './i18n/useI18n.ts'
import { downloadBlob } from './utils/download.ts'
import './App.css'

type WorkspaceTab = 'source' | 'target' | 'mapping' | 'code'
const TABS: WorkspaceTab[] = ['source', 'target', 'mapping', 'code']
// The work kept in this browser when the user asks for it (opt-in): never sent anywhere
const WORKSPACE_KEY = 'mapper.workspace'
const TOOL_NAMES: Record<string, string> = { api2class: 'Api2Class', dbcreate: 'DBCreate', datacleanr: 'DataCleanr', mapper: 'Mapper' }

function loadSaved(): MapperProject | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY)
    if (!raw) return null
    const read = readProject(raw)
    return read.ok ? read.project : null
  } catch {
    return null
  }
}

/** A model sent by another tool, as the input of its side. */
function inputFromHandoff(handoff: Handoff): InputState {
  return handoff.text
    ? {
        text: handoff.text.content,
        format: findParser(handoff.text.format as InputFormatId)?.id ?? null,
        model: handoff.model ?? null,
        receivedFrom: TOOL_NAMES[handoff.from],
      }
    : {
        text: JSON.stringify(handoff.schema, null, 2),
        format: 'modelschema',
        model: handoff.model ?? null,
        receivedFrom: TOOL_NAMES[handoff.from],
      }
}

interface Startup {
  source: InputState
  target: InputState
  mapping: MappingSet | null
  /** Models the mapping was made for, so it is not recomputed on the first render */
  modelsKey: string
  tab: WorkspaceTab
  restored: boolean
}

let startup: Startup | null = null

/** What the page opens with: a model sent by another tool, the work kept in this browser (when the user
 * asked for it), or nothing. Computed once: the handoff can only be read once. */
function getStartup(): Startup {
  if (startup) return startup
  startup = { source: EMPTY_INPUT, target: EMPTY_INPUT, mapping: null, modelsKey: '', tab: 'source', restored: false }
  const incoming = typeof sessionStorage === 'undefined' ? null : takeIncoming(sessionStorage)
  if (incoming) {
    startup[incoming.role] = inputFromHandoff(incoming)
    startup.tab = incoming.role === 'source' ? 'target' : 'source'
    return startup
  }
  let remember = false
  try {
    remember = JSON.parse(localStorage.getItem('mapper.remember') ?? 'false') === true
  } catch {
    // Unavailable storage: start empty
  }
  const saved = remember ? loadSaved() : null
  if (saved) {
    startup = {
      source: { text: saved.source.text, format: saved.source.format, model: saved.source.model },
      target: { text: saved.target.text, format: saved.target.format, model: saved.target.model },
      mapping: saved.mapping,
      modelsKey: JSON.stringify([saved.source.schema, saved.source.model, saved.target.schema, saved.target.model]),
      tab: 'mapping',
      restored: true,
    }
  }
  return startup
}

function App() {
  const { t } = useI18n()
  const initial = getStartup()
  const [source, setSource] = useState<InputState>(initial.source)
  const [target, setTarget] = useState<InputState>(initial.target)
  const [tab, setTab] = useState<WorkspaceTab>(initial.tab)
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'error' } | null>(() =>
    initial.restored ? { text: t.restored, kind: 'ok' } : null,
  )
  const history = useHistory<MappingSet | null>(initial.mapping)

  // Preferences (remembered); the inputs and the mapping are not, unless the user turns it on
  const [generatorId, setGeneratorId] = useStoredState('mapper.generator', () => 'typescript')
  const [modes, setModes] = useStoredState<Record<string, string>>('mapper.modes', () => ({}))
  const [naming, setNaming] = useStoredState<NamingMode>('mapper.naming', () => 'auto')
  const [options, setOptions] = useStoredState<Record<string, Record<string, string>>>('mapper.options', () => ({}))
  const [remember, setRemember] = useStoredState('mapper.remember', () => false)
  const [hasSaved, setHasSaved] = useState(() => loadSaved() !== null)

  // Large inputs are parsed after the keystroke is painted, so typing stays smooth
  const deferredSource = useDeferredValue(source)
  const deferredTarget = useDeferredValue(target)
  const sourceRead = useMemo(() => readInput(deferredSource, 'source'), [deferredSource])
  const targetRead = useMemo(() => readInput(deferredTarget, 'target'), [deferredTarget])
  const sourceSchema = sourceRead.outcome?.ok ? sourceRead.outcome.schema : null
  const targetSchema = targetRead.outcome?.ok ? targetRead.outcome.schema : null

  // New suggestions whenever the models change, keeping the user's decisions where they still apply
  const lastModels = useRef(initial.modelsKey)
  const presentRef = useRef(history.present)
  // Declared before the effect that reads it: effects run in order
  useEffect(() => {
    presentRef.current = history.present
  }, [history.present])
  useEffect(() => {
    if (!sourceSchema || !targetSchema || !sourceRead.model || !targetRead.model) {
      if (lastModels.current !== '') {
        lastModels.current = ''
        history.reset(null)
      }
      return
    }
    const key = JSON.stringify([sourceSchema, sourceRead.model, targetSchema, targetRead.model])
    if (key === lastModels.current) return
    lastModels.current = key
    history.reset(reconcile(presentRef.current, sourceSchema, sourceRead.model, targetSchema, targetRead.model))
  }, [sourceSchema, targetSchema, sourceRead.model, targetRead.model, history])

  const set = history.present
  const diagnostics = useMemo(
    () => (set && sourceSchema && targetSchema ? validateMapping(set, sourceSchema, targetSchema) : []),
    [set, sourceSchema, targetSchema],
  )
  const plan = useMemo(
    () => (set && sourceSchema && targetSchema ? buildPlan(set, sourceSchema, targetSchema) : null),
    [set, sourceSchema, targetSchema],
  )
  const generator = findGenerator(generatorId)
  const settings: GenerateSettings = useMemo(
    () => ({
      mode: modes[generator.id] && generator.modes.includes(modes[generator.id]) ? modes[generator.id] : generator.modes[0],
      naming,
      options: options[generator.id] ?? {},
    }),
    [generator, modes, naming, options],
  )
  const output = useMemo(() => (plan ? generator.generate(plan, settings) : null), [plan, generator, settings])
  const summary = summarize(set)
  const pending = summary.review + summary.conflict

  const hasWork = source.text.trim() !== '' || target.text.trim() !== ''

  /** Puts a project (an example, a saved file, the browser's copy) in the workspace. */
  const applyProject = useCallback(
    (project: MapperProject) => {
      setSource({ text: project.source.text, format: project.source.format, model: project.source.model })
      setTarget({ text: project.target.text, format: project.target.format, model: project.target.model })
      lastModels.current = JSON.stringify([project.source.schema, project.source.model, project.target.schema, project.target.model])
      history.reset(project.mapping)
      setGeneratorId(project.output.generator)
      setModes((current) => ({ ...current, [project.output.generator]: project.output.mode }))
      setNaming(project.output.naming)
      setOptions((current) => ({ ...current, ...project.output.options }))
    },
    [history, setGeneratorId, setModes, setNaming, setOptions],
  )

  const currentProject = useCallback((): MapperProject | null => {
    if (!set || !sourceSchema || !targetSchema || !sourceRead.format || !targetRead.format || !sourceRead.model || !targetRead.model)
      return null
    return createProject(
      { format: sourceRead.format, text: source.text, model: sourceRead.model, schema: sourceSchema },
      { format: targetRead.format, text: target.text, model: targetRead.model, schema: targetSchema },
      set,
      { generator: generator.id, mode: settings.mode, naming, options },
    )
  }, [set, sourceSchema, targetSchema, sourceRead, targetRead, source.text, target.text, generator.id, settings.mode, naming, options])

  // The browser's copy of the work, kept up to date while "remember" is on
  useEffect(() => {
    if (!remember) return
    const timer = setTimeout(() => {
      const project = currentProject()
      if (!project) return
      try {
        localStorage.setItem(WORKSPACE_KEY, JSON.stringify(project))
        setHasSaved(true)
      } catch {
        // Full or blocked storage: the work is simply not kept
      }
    }, 600)
    return () => clearTimeout(timer)
  }, [remember, currentProject])

  /** A model sent by another tool of the family (Api2Class "Open in Mapper"). */
  function receive(handoff: Handoff) {
    const input = inputFromHandoff(handoff)
    if (handoff.role === 'source') setSource(input)
    else setTarget(input)
    setTab(handoff.role === 'source' ? 'target' : 'source')
  }

  // A tool in another tab can also send a model with postMessage; only trusted origins are heard
  useEffect(() => {
    function listen(event: MessageEvent) {
      if (!isTrustedOrigin(event.origin, window.location.origin)) return
      const handoff = readHandoff(event.data)
      if (handoff) receive(handoff)
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [])

  // Undo and redo with the keyboard, except while typing in a field (it has its own undo)
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const element = event.target as HTMLElement | null
      if (element && element.closest('input, textarea, select, [contenteditable="true"], .cm-editor') !== null) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey && history.canUndo) {
        event.preventDefault()
        history.undo()
      } else if (((key === 'z' && event.shiftKey) || key === 'y') && history.canRedo) {
        event.preventDefault()
        history.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [history])

  function loadExample(id: ExampleId) {
    const example = findExample(id)
    if (!example) return
    if (hasWork && !window.confirm(t.confirmReplace)) return
    setSource({ text: example.source.text, format: example.source.format, model: example.source.model })
    setTarget({ text: example.target.text, format: example.target.format, model: example.target.model })
    setGeneratorId(example.language)
    setMessage(null)
    setTab('mapping')
  }

  async function openProject(file: File) {
    try {
      const read = readProject(await file.text())
      if (!read.ok) {
        setMessage({ text: t.projectError(read.error, read.path), kind: 'error' })
        return
      }
      if (hasWork && !window.confirm(t.confirmReplace)) return
      applyProject(read.project)
      setMessage({ text: t.projectLoaded(file.name), kind: 'ok' })
      setTab('mapping')
    } catch {
      setMessage({ text: t.fileError(file.name), kind: 'error' })
    }
  }

  function saveProject() {
    const project = currentProject()
    if (!project) return
    downloadBlob(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), projectFileName(project))
  }

  function exportTarget() {
    if (!targetSchema) return
    const schema = { ...targetSchema, format: MODEL_SCHEMA_FORMAT, root: targetRead.model ?? targetSchema.root }
    downloadBlob(new Blob([JSON.stringify(schema, null, 2)], { type: 'application/json' }), `${targetRead.model ?? 'target'}.model.json`)
  }

  /** A new target model written from the source, to edit as text. */
  function createTarget(format: DraftFormat) {
    if (!sourceSchema || !sourceRead.model) return
    const draft = draftTarget(sourceSchema, sourceRead.model, format)
    if (!draft) return
    setTarget({ text: draft.text, format, model: draft.model })
    setMessage({ text: t.created(draft.model, sourceRead.model), kind: 'ok' })
    setTab('target')
  }

  function clearSaved() {
    try {
      localStorage.removeItem(WORKSPACE_KEY)
    } catch {
      // Nothing to delete
    }
    setRemember(false)
    setHasSaved(false)
    setMessage({ text: t.savedCleared, kind: 'ok' })
  }

  const waitingFor = !sourceSchema && !targetSchema ? 'both' : !sourceSchema ? 'source' : !targetSchema ? 'target' : null
  const inputError = (read: typeof sourceRead, input: InputState) =>
    input.text.trim() !== '' && (!read.format || (read.outcome !== null && !read.outcome.ok))

  return (
    <div className="app">
      <AppHeader />
      <main className="app__main">
        <IntroPanel onExample={loadExample} />
        <ProjectBar
          canSave={currentProject() !== null}
          canExportTarget={targetSchema !== null}
          remember={remember}
          hasSaved={hasSaved}
          message={message}
          onSave={saveProject}
          onOpen={(file) => void openProject(file)}
          onExportTarget={exportTarget}
          onRememberChange={setRemember}
          onClearSaved={clearSaved}
        />
        <div className="workspace__tabs" role="tablist" aria-label={t.workspaceTabs}>
          {TABS.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className="workspace__tab" onClick={() => setTab(id)}>
              {t.tabs[id]}
              {id === 'mapping' && pending > 0 && <span className="workspace__tab-badge">{pending}</span>}
              {((id === 'source' && inputError(sourceRead, source)) || (id === 'target' && inputError(targetRead, target))) && (
                <span className="workspace__tab-badge workspace__tab-badge--error">!</span>
              )}
            </button>
          ))}
        </div>
        <div className="workspace" data-tab={tab}>
          <div className="workspace__inputs">
            <InputPane role="source" input={source} read={sourceRead} onChange={setSource} />
            <InputPane
              role="target"
              input={target}
              read={targetRead}
              onChange={setTarget}
              create={{ sourceModel: sourceSchema ? sourceRead.model : null, onCreate: createTarget }}
            />
          </div>
          <MappingPanel
            set={set}
            source={sourceSchema}
            target={targetSchema}
            waitingFor={waitingFor}
            diagnostics={diagnostics}
            onChange={history.push}
            canUndo={history.canUndo}
            canRedo={history.canRedo}
            onUndo={history.undo}
            onRedo={history.redo}
          />
          <div className="workspace__code">
            <CodePanel
              generator={generator}
              settings={settings}
              plan={plan}
              output={output}
              onGeneratorChange={setGeneratorId}
              onSettingsChange={(next) => {
                setModes((current) => ({ ...current, [generator.id]: next.mode }))
                setNaming(next.naming)
                setOptions((current) => ({ ...current, [generator.id]: next.options }))
              }}
            />
          </div>
        </div>
        <LinksPanel />
      </main>
      <AppFooter />
    </div>
  )
}

export default App
