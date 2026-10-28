import { Fragment, useState } from 'react'
import { categoryOf, matchesFilter, reachable, summarize, type Filter } from '../app/workspace.ts'
import { compatibility } from '../core/model/compatibility.ts'
import { acceptAllReviews, acceptCandidate, restoreSuggestions, toggleIgnoredSource } from '../core/mapping/edit.ts'
import { resolvePath } from '../core/mapping/paths.ts'
import { pathKey, type FieldMapping, type MappingSet, type ModelMapping } from '../core/mapping/types.ts'
import { summarizeDiagnostics, type Diagnostic } from '../core/mapping/validate.ts'
import { allFields, describeType, findModel, needsValue, type ModelSchema } from '../core/model/schema.ts'
import { useI18n } from '../i18n/useI18n.ts'
import { ConfidenceBadge } from './ConfidenceBadge.tsx'
import { FieldEditor } from './FieldEditor.tsx'
import './MappingPanel.css'

const FILTERS: Filter[] = ['all', 'review', 'unmapped', 'mapped', 'warnings']

interface MappingPanelProps {
  set: MappingSet | null
  source: ModelSchema | null
  target: ModelSchema | null
  /** Why there is no mapping yet: one side cannot be read */
  waitingFor: 'source' | 'target' | 'both' | null
  diagnostics: Diagnostic[]
  onChange: (set: MappingSet) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}

export function MappingPanel({
  set,
  source,
  target,
  waitingFor,
  diagnostics,
  onChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: MappingPanelProps) {
  const { t } = useI18n()
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  if (!set || !source || !target) {
    return (
      <section className="mapping panel" aria-labelledby="mapping-title">
        <h2 id="mapping-title" className="mapping__title">
          {t.mappingTitle}
        </h2>
        <p className="empty-state">{waitingFor === 'both' || waitingFor === null ? t.mappingEmpty : t.mappingWaiting(waitingFor)}</p>
      </section>
    )
  }

  const mappings = reachable(set)
  const summary = summarize(set)
  const reviewable = mappings.reduce(
    (total, mapping) => total + mapping.fields.filter((field) => field.status === 'pending' && field.confidence !== 'conflict').length,
    0,
  )
  const counts = summarizeDiagnostics(diagnostics)
  const severityOrder = diagnostics.filter((item) => item.severity !== 'info' || item.code !== 'unusedSource')

  const statusOf = (field: FieldMapping) => {
    if (field.status === 'ignored') return <ConfidenceBadge confidence="ignored" />
    if (field.status === 'active' && field.manual) return <ConfidenceBadge confidence="manual" />
    const score = field.candidates?.[0]?.score
    return (
      <ConfidenceBadge
        confidence={field.status === 'unmapped' ? 'none' : field.confidence}
        score={score}
        title={field.reasons?.map((reason) => t.reason(reason)).join(' ')}
      />
    )
  }

  const sourceText = (field: FieldMapping) => {
    if (field.transform.kind === 'constant') return <span className="mapping__constant mono">{JSON.stringify(field.transform.value)}</span>
    if (field.transform.kind === 'expression') return <span className="mapping__constant mono">{field.transform.expression}</span>
    if (field.sources.length === 0) return <span className="mapping__none">{t.noSource}</span>
    return field.sources.map((path, index) => (
      <Fragment key={pathKey(path)}>
        {index > 0 && <span className="mapping__plus"> + </span>}
        <span className="mapping__path mono">{path.length === 0 ? `(${t.root})` : pathKey(path)}</span>
      </Fragment>
    ))
  }

  const transformText = (mapping: ModelMapping, field: FieldMapping) => {
    const summaryText = t.transformSummary(field.transform)
    if (field.transform.kind !== 'direct')
      return `${t.transform[field.transform.kind]}${summaryText && summaryText !== t.transform[field.transform.kind].toLowerCase() ? ` · ${summaryText}` : ''}`
    // A direct relation that converts the type says so: "string → integer"
    const resolved = field.sources[0] ? resolvePath(source, mapping.source, field.sources[0]) : null
    const targetModel = findModel(target, mapping.target)
    const targetField = targetModel && allFields(target, targetModel).find((item) => item.name === field.target)
    if (resolved && targetField && compatibility(resolved.type, targetField.type).level !== 'same')
      return t.conversionHint(describeType(resolved.type), describeType(targetField.type))
    return ''
  }

  const fieldDiagnostics = (mapping: ModelMapping, field: FieldMapping) =>
    diagnostics.filter(
      (item) =>
        item.mapping === mapping.id &&
        item.target === field.target &&
        item.severity !== 'info' &&
        item.code !== 'pendingSuggestion' &&
        item.code !== 'conflictPending',
    )

  return (
    <section className="mapping panel" aria-labelledby="mapping-title">
      <div className="mapping__header">
        <h2 id="mapping-title" className="mapping__title">
          {t.mappingTitle}
        </h2>
        <div className="mapping__toolbar actions">
          {reviewable > 0 && (
            <button
              type="button"
              className="button button--primary"
              onClick={() => onChange(mappings.reduce((current, mapping) => acceptAllReviews(current, mapping.id), set))}
            >
              {t.acceptReviews(reviewable)}
            </button>
          )}
          <button type="button" className="button" onClick={onUndo} disabled={!canUndo} title={t.undoTitle}>
            {t.undo}
          </button>
          <button type="button" className="button" onClick={onRedo} disabled={!canRedo} title={t.redoTitle}>
            {t.redo}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              if (window.confirm(t.restoreConfirm)) onChange(restoreSuggestions(set, source, target, set.root))
            }}
          >
            {t.restoreSuggestions}
          </button>
        </div>
      </div>

      <p className="mapping__summary" role="status">
        <span>{t.summary.total(summary.total)}</span>
        <span className="mapping__count mapping__count--success">{t.summary.mapped(summary.mapped)}</span>
        {summary.review > 0 && <span className="mapping__count mapping__count--warning">{t.summary.review(summary.review)}</span>}
        {summary.conflict > 0 && <span className="mapping__count mapping__count--warning">{t.summary.conflict(summary.conflict)}</span>}
        {summary.unmapped > 0 && <span className="mapping__count">{t.summary.unmapped(summary.unmapped)}</span>}
        {summary.ignored > 0 && <span className="mapping__count">{t.summary.ignored(summary.ignored)}</span>}
      </p>

      <div className="mapping__filters">
        <div className="mapping__filter-group" role="group" aria-label={t.filterLabel}>
          {FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              className="button button--small"
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
            >
              {t.filters[item]}
            </button>
          ))}
        </div>
        <input
          className="input mapping__search"
          type="search"
          aria-label={t.searchLabel}
          placeholder={t.searchPlaceholder}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {mappings.map((mapping) => {
        const targetModel = findModel(target, mapping.target)
        const sourceModel = findModel(source, mapping.source)
        if (!targetModel || !sourceModel) return null
        const targetFields = allFields(target, targetModel)
        const visible = mapping.fields.filter((field) => matchesFilter(field, filter, search, diagnostics, mapping.id))
        const unused = diagnostics
          .filter((item) => item.mapping === mapping.id && item.code === 'unusedSource')
          .map((item) => String(item.params?.field))
        const ignored = mapping.ignoredSources
        return (
          <section key={mapping.id} className="mapping__section" aria-label={t.nested(mapping.source, mapping.target)}>
            <h3 className="mapping__model">{t.nested(mapping.source, mapping.target)}</h3>
            <div className="mapping__columns" aria-hidden="true">
              <span>{t.columns.source}</span>
              <span />
              <span>{t.columns.target}</span>
              <span>{t.columns.status}</span>
              <span />
            </div>
            {visible.length === 0 ? (
              <p className="mapping__no-results">{t.noResults}</p>
            ) : (
              <ul className="mapping__rows">
                {visible.map((field) => {
                  const targetField = targetFields.find((item) => item.name === field.target)
                  if (!targetField) return null
                  const key = `${mapping.id}:${field.target}`
                  const editing = open === key
                  const category = categoryOf(field)
                  const transform = transformText(mapping, field)
                  const issues = fieldDiagnostics(mapping, field)
                  return (
                    <li key={key} className={`mapping__row mapping__row--${category}${editing ? ' mapping__row--open' : ''}`}>
                      <div className="mapping__line">
                        <div className={`mapping__source${field.status === 'pending' ? ' mapping__source--proposed' : ''}`}>
                          {field.status === 'ignored' ? <span className="mapping__none">{t.noSource}</span> : sourceText(field)}
                        </div>
                        <div className={`mapping__arrow${transform ? '' : ' mapping__arrow--plain'}`}>
                          <span aria-hidden="true">→</span>
                          {transform && (
                            <span className="mapping__transform" title={transform}>
                              {transform}
                            </span>
                          )}
                        </div>
                        <div className="mapping__target">
                          <span className="mono mapping__target-name">{field.target}</span>
                          <span className="mapping__type">{describeType(targetField.type)}</span>
                          {targetField.nullable && <span className="badge">null</span>}
                          {needsValue(targetField) && field.status !== 'active' && (
                            <span className="badge badge--danger">{t.requiredBadge}</span>
                          )}
                        </div>
                        <div className="mapping__status">{statusOf(field)}</div>
                        <div className="mapping__actions">
                          {field.status === 'pending' && field.confidence !== 'conflict' && (
                            <button
                              type="button"
                              className="button button--small"
                              aria-label={t.acceptLabel(field.target)}
                              onClick={() => onChange(acceptCandidate(set, mapping.id, field.target))}
                            >
                              {t.accept}
                            </button>
                          )}
                          <button
                            type="button"
                            className="button button--small"
                            aria-expanded={editing}
                            aria-label={t.editFieldLabel(field.target)}
                            onClick={() => setOpen(editing ? null : key)}
                          >
                            {editing ? t.close : t.edit}
                          </button>
                        </div>
                      </div>
                      {issues.length > 0 && (
                        <ul className="mapping__issues">
                          {issues.map((issue) => (
                            <li key={issue.code} className={`mapping__issue mapping__issue--${issue.severity}`}>
                              <strong>{t.severity[issue.severity]}:</strong> {t.diagnostic(issue.code, field.target, issue.params)}
                            </li>
                          ))}
                        </ul>
                      )}
                      {editing && (
                        <FieldEditor
                          set={set}
                          mapping={mapping}
                          field={field}
                          targetField={targetField}
                          source={source}
                          target={target}
                          diagnostics={diagnostics}
                          onChange={onChange}
                          onClose={() => setOpen(null)}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {(unused.length > 0 || ignored.length > 0) && (
              <details className="mapping__unused">
                <summary>{t.unusedTitle(unused.length)}</summary>
                <p className="field__hint">{t.unusedHint}</p>
                <ul className="mapping__unused-list">
                  {[...unused, ...ignored].map((name) => (
                    <li key={name}>
                      <span className={`mono${ignored.includes(name) ? ' mapping__ignored' : ''}`}>{name}</span>
                      {ignored.includes(name) && <span className="badge">{t.ignoredSource}</span>}
                      <button
                        type="button"
                        className="button button--small"
                        onClick={() => onChange(toggleIgnoredSource(set, mapping.id, name.split('.')))}
                      >
                        {ignored.includes(name) ? t.unmarkIgnored : t.markIgnored}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )
      })}

      <details className="mapping__diagnostics" open={counts.error > 0}>
        <summary>
          {t.diagnosticsTitle}:{' '}
          <span
            className={
              counts.error > 0 ? 'mapping__count--danger' : counts.warning > 0 ? 'mapping__count--warning' : 'mapping__count--success'
            }
          >
            {t.diagnosticsSummary(counts.error, counts.warning, counts.info)}
          </span>
        </summary>
        <ul className="mapping__issues">
          {severityOrder.map((item, index) => (
            <li key={`${item.mapping}-${item.target}-${item.code}-${index}`} className={`mapping__issue mapping__issue--${item.severity}`}>
              <strong>{t.severity[item.severity]}:</strong> {t.diagnostic(item.code, item.target ?? '', item.params)}
              {item.mapping !== set.root && <span className="mapping__issue-model"> ({item.mapping.replace('->', ' → ')})</span>}
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
