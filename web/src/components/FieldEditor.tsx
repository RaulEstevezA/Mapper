import { useId, useState } from 'react'
import { acceptCandidate, chooseSources, ignoreTarget, resetField, setExpression, setFallback, setTransform } from '../core/mapping/edit.ts'
import { resolvePath } from '../core/mapping/paths.ts'
import {
  pathKey,
  type ArithmeticOperator,
  type FieldMapping,
  type MappingSet,
  type ModelMapping,
  type SourcePath,
  type Transform,
} from '../core/mapping/types.ts'
import type { Diagnostic } from '../core/mapping/validate.ts'
import { sourceOptions, suggestEnumPairs } from '../core/matching/engine.ts'
import { describeType, findEnum, findModel, type FieldDef, type Literal, type ModelSchema, type TypeRef } from '../core/model/schema.ts'
import { useI18n } from '../i18n/useI18n.ts'
import { ConfidenceBadge } from './ConfidenceBadge.tsx'
import './FieldEditor.css'

interface FieldEditorProps {
  set: MappingSet
  mapping: ModelMapping
  field: FieldMapping
  targetField: FieldDef
  source: ModelSchema
  target: ModelSchema
  diagnostics: Diagnostic[]
  onChange: (set: MappingSet) => void
  onClose: () => void
}

const isPrimitive = (type: TypeRef | undefined, ...names: string[]) => type?.kind === 'primitive' && names.includes(type.name)
const isText = (type: TypeRef | undefined) => isPrimitive(type, 'string', 'any')
const isNumber = (type: TypeRef | undefined) => isPrimitive(type, 'integer', 'float', 'decimal')
const isDate = (type: TypeRef | undefined) => isPrimitive(type, 'datetime', 'date')

/** Transformations that make sense for these types: the rest are not offered. */
function availableTransforms(sourceType: TypeRef | undefined, targetType: TypeRef): Transform['kind'][] {
  const kinds: Transform['kind'][] = ['direct']
  if (isText(targetType)) kinds.push('concat')
  if (isText(sourceType) && isText(targetType)) kinds.push('split')
  if (isPrimitive(targetType, 'boolean') && (isText(sourceType) || sourceType?.kind === 'enum')) kinds.push('boolean')
  if (targetType.kind === 'enum' && (isText(sourceType) || sourceType?.kind === 'enum')) kinds.push('enum')
  if ((isNumber(sourceType) && isDate(targetType)) || (isDate(sourceType) && isNumber(targetType))) kinds.push('epoch')
  if (isNumber(sourceType) && isNumber(targetType)) kinds.push('arithmetic')
  kinds.push('constant', 'expression')
  return kinds
}

function defaultConstant(type: TypeRef, target: ModelSchema): Literal {
  if (type.kind === 'enum') return findEnum(target, type.name)?.values[0]?.name ?? ''
  if (isNumber(type)) return 0
  if (isPrimitive(type, 'boolean')) return false
  return ''
}

/** A value typed by the user, read as the target field's type. Empty text means "no value". */
function parseValue(text: string, type: TypeRef): Literal | undefined {
  if (text === '') return undefined
  if (isNumber(type)) {
    const value = Number(text)
    return Number.isFinite(value) ? value : undefined
  }
  if (isPrimitive(type, 'boolean')) return text === 'true'
  return text
}

export function FieldEditor({ set, mapping, field, targetField, source, target, diagnostics, onChange, onClose }: FieldEditorProps) {
  const { t } = useI18n()
  const id = useId()
  const sourceModel = findModel(source, mapping.source)
  const options = sourceModel ? sourceOptions(source, sourceModel) : []
  const firstSource = field.sources[0] ? resolvePath(source, mapping.source, field.sources[0]) : null
  const sourceType = firstSource?.type
  const transform = field.transform
  const kinds = availableTransforms(sourceType, targetField.type)
  const [trueValuesText, setTrueValuesText] = useState(transform.kind === 'boolean' ? transform.trueValues.join(', ') : '')
  const expressionError = diagnostics.find((item) => item.code === 'invalidExpression' && item.target === field.target)?.expressionError
  const targetEnum = targetField.type.kind === 'enum' ? findEnum(target, targetField.type.name) : undefined
  const sourceEnum = sourceType?.kind === 'enum' ? findEnum(source, sourceType.name) : undefined
  const update = (next: MappingSet) => onChange(next)
  const targetIsModel = targetField.type.kind === 'model'

  function changeKind(kind: Transform['kind']) {
    switch (kind) {
      case 'direct':
        update(
          chooseSources(
            set,
            source,
            target,
            mapping.id,
            field.target,
            field.sources.slice(0, 1).length > 0 ? field.sources.slice(0, 1) : [],
          ),
        )
        return
      case 'concat':
        update(setTransform(set, mapping.id, field.target, { kind: 'concat', separator: ' ' }))
        return
      case 'split':
        update(setTransform(set, mapping.id, field.target, { kind: 'split', separator: ' ', part: 0 }))
        return
      case 'constant':
        update(setTransform(set, mapping.id, field.target, { kind: 'constant', value: defaultConstant(targetField.type, target) }))
        return
      case 'boolean':
        setTrueValuesText('')
        update(setTransform(set, mapping.id, field.target, { kind: 'boolean', trueValues: [] }))
        return
      case 'enum': {
        const pairs = sourceEnum && targetEnum ? suggestEnumPairs(source, sourceEnum.name, target, targetEnum.name) : []
        update(setTransform(set, mapping.id, field.target, { kind: 'enum', pairs }))
        return
      }
      case 'epoch':
        update(setTransform(set, mapping.id, field.target, { kind: 'epoch', unit: 'seconds' }))
        return
      case 'arithmetic':
        update(setTransform(set, mapping.id, field.target, { kind: 'arithmetic', operator: '/', operand: 100 }))
        return
      case 'expression':
        update(setExpression(set, mapping.id, field.target, field.sources.map(pathKey).join(' + ')))
        return
      default:
        return
    }
  }

  function setSourceAt(index: number, path: SourcePath | null) {
    const sources = [...field.sources]
    if (path === null) sources.splice(index, 1)
    else sources[index] = path
    const next = chooseSources(set, source, target, mapping.id, field.target, sources)
    // Keeping a concatenation while its fields change
    update(transform.kind === 'concat' && sources.length > 1 ? setTransform(next, mapping.id, field.target, transform) : next)
  }

  const sourceSelect = (value: SourcePath | null, index: number, label: string) => (
    <select
      className="select input--mono"
      aria-label={label}
      value={value ? (value.length === 0 ? '.' : pathKey(value)) : ''}
      onChange={(event) => {
        const selected = event.target.value
        if (selected === '') return
        setSourceAt(index, selected === '.' ? [] : selected.split('.'))
      }}
    >
      <option value="">{t.chooseSource}</option>
      {targetIsModel && <option value=".">({t.root})</option>}
      {options.map((option) => (
        <option key={pathKey(option.path)} value={pathKey(option.path)}>
          {pathKey(option.path)} · {describeType(option.field.type)}
        </option>
      ))}
    </select>
  )

  const showSources = transform.kind !== 'constant' && transform.kind !== 'expression'
  const candidates = (field.candidates ?? []).filter((candidate) => candidate.sources.length > 0 || candidate.transform.kind === 'constant')

  return (
    <div className="field-editor" role="group" aria-labelledby={`${id}-title`}>
      <div className="field-editor__header">
        <h4 id={`${id}-title`} className="field-editor__title">
          {t.editFieldTitle(field.target)} <span className="field-editor__type">{describeType(targetField.type)}</span>
        </h4>
        <button type="button" className="button button--small" onClick={onClose}>
          {t.close}
        </button>
      </div>

      {candidates.length > 0 && (field.status !== 'active' || candidates.length > 1) && (
        <div className="field-editor__section">
          <h5 className="field-editor__label">{t.candidatesTitle}</h5>
          <ul className="field-editor__candidates">
            {candidates.map((candidate) => (
              <li key={`${candidate.sources.map(pathKey).join('+')}-${candidate.transform.kind}`} className="field-editor__candidate">
                <span className="mono">
                  {candidate.sources.map((path) => (path.length === 0 ? `(${t.root})` : pathKey(path))).join(' + ')}
                </span>
                {candidate.transform.kind !== 'direct' && (
                  <span className="field-editor__muted">{t.transform[candidate.transform.kind]}</span>
                )}
                <ConfidenceBadge confidence={candidate.confidence} score={candidate.score} />
                <span className="field-editor__muted field-editor__reasons">
                  {candidate.reasons.map((reason) => t.reason(reason)).join(' ')}
                </span>
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => update(acceptCandidate(set, mapping.id, field.target, (field.candidates ?? []).indexOf(candidate)))}
                >
                  {t.useCandidate}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="field-editor__grid">
        <label className="field">
          <span>{t.transformLabel}</span>
          <select
            className="select"
            value={transform.kind === 'object' || transform.kind === 'collection' ? 'direct' : transform.kind}
            onChange={(event) => changeKind(event.target.value as Transform['kind'])}
          >
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind === 'direct' && (transform.kind === 'object' || transform.kind === 'collection')
                  ? t.transform[transform.kind]
                  : t.transform[kind]}
              </option>
            ))}
          </select>
        </label>

        {showSources && (
          <div className="field field-editor__sources">
            <span>{t.sourcesLabel}</span>
            {(field.sources.length > 0 ? field.sources : [null]).map((path, index) => (
              <div key={index} className="field-editor__source">
                {sourceSelect(path, index, `${t.sourcesLabel} ${index + 1}`)}
                {transform.kind === 'concat' && field.sources.length > 1 && path && (
                  <button
                    type="button"
                    className="button button--small"
                    aria-label={t.removeSource(pathKey(path))}
                    onClick={() => setSourceAt(index, null)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {transform.kind === 'concat' && (
              <div className="field-editor__source">{sourceSelect(null, field.sources.length, t.addSource)}</div>
            )}
          </div>
        )}

        {transform.kind === 'concat' && (
          <label className="field">
            <span>{t.separatorLabel}</span>
            <input
              className="input input--mono"
              value={transform.separator}
              onChange={(event) => update(setTransform(set, mapping.id, field.target, { ...transform, separator: event.target.value }))}
            />
          </label>
        )}

        {transform.kind === 'split' && (
          <>
            <label className="field">
              <span>{t.separatorLabel}</span>
              <input
                className="input input--mono"
                value={transform.separator}
                onChange={(event) =>
                  update(setTransform(set, mapping.id, field.target, { ...transform, separator: event.target.value || ' ' }))
                }
              />
            </label>
            <label className="field">
              <span>{t.partLabel}</span>
              <select
                className="select"
                value={String(transform.part)}
                onChange={(event) => {
                  const value = event.target.value
                  update(
                    setTransform(set, mapping.id, field.target, {
                      ...transform,
                      part: value === 'last' || value === 'rest' ? value : Number(value),
                    }),
                  )
                }}
              >
                <option value="0">{t.parts.first}</option>
                <option value="rest">{t.parts.rest}</option>
                <option value="last">{t.parts.last}</option>
              </select>
            </label>
          </>
        )}

        {transform.kind === 'constant' &&
          (targetEnum ? (
            <label className="field">
              <span>{t.constantLabel}</span>
              <select
                className="select"
                value={String(transform.value ?? '')}
                onChange={(event) => update(setTransform(set, mapping.id, field.target, { kind: 'constant', value: event.target.value }))}
              >
                {targetEnum.values.map((value) => (
                  <option key={value.name} value={value.name}>
                    {value.name}
                  </option>
                ))}
              </select>
            </label>
          ) : isPrimitive(targetField.type, 'boolean') ? (
            <label className="field">
              <span>{t.constantLabel}</span>
              <select
                className="select"
                value={String(transform.value)}
                onChange={(event) =>
                  update(setTransform(set, mapping.id, field.target, { kind: 'constant', value: event.target.value === 'true' }))
                }
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
          ) : (
            <label className="field">
              <span>{t.constantLabel}</span>
              <input
                className="input input--mono"
                type={isNumber(targetField.type) ? 'number' : 'text'}
                value={transform.value === null ? '' : String(transform.value)}
                placeholder={t.constantNull}
                onChange={(event) =>
                  update(
                    setTransform(set, mapping.id, field.target, {
                      kind: 'constant',
                      value: parseValue(event.target.value, targetField.type) ?? null,
                    }),
                  )
                }
              />
            </label>
          ))}

        {transform.kind === 'boolean' && (
          <label className="field field-editor__wide">
            <span>{t.trueValuesLabel}</span>
            <input
              className="input input--mono"
              value={trueValuesText}
              list={sourceEnum ? `${id}-values` : undefined}
              onChange={(event) => {
                setTrueValuesText(event.target.value)
                const values = event.target.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter((value) => value !== '')
                update(setTransform(set, mapping.id, field.target, { kind: 'boolean', trueValues: values }))
              }}
            />
            {sourceEnum && (
              <datalist id={`${id}-values`}>
                {sourceEnum.values.map((value) => (
                  <option key={value.name} value={value.name} />
                ))}
              </datalist>
            )}
          </label>
        )}

        {transform.kind === 'epoch' && (
          <label className="field">
            <span>{t.epochUnitLabel}</span>
            <select
              className="select"
              value={transform.unit}
              onChange={(event) =>
                update(
                  setTransform(set, mapping.id, field.target, { kind: 'epoch', unit: event.target.value as 'seconds' | 'milliseconds' }),
                )
              }
            >
              <option value="seconds">{t.epochUnits.seconds}</option>
              <option value="milliseconds">{t.epochUnits.milliseconds}</option>
            </select>
          </label>
        )}

        {transform.kind === 'arithmetic' && (
          <>
            <label className="field">
              <span>{t.operatorLabel}</span>
              <select
                className="select"
                value={transform.operator}
                onChange={(event) =>
                  update(setTransform(set, mapping.id, field.target, { ...transform, operator: event.target.value as ArithmeticOperator }))
                }
              >
                {(['*', '/', '+', '-'] as const).map((operator) => (
                  <option key={operator} value={operator}>
                    {operator}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t.operandLabel}</span>
              <input
                className="input input--mono"
                type="number"
                value={transform.operand}
                onChange={(event) => {
                  const operand = Number(event.target.value)
                  if (Number.isFinite(operand)) update(setTransform(set, mapping.id, field.target, { ...transform, operand }))
                }}
              />
            </label>
          </>
        )}
      </div>

      {transform.kind === 'enum' && (
        <div className="field-editor__section">
          <table className="field-editor__pairs">
            <thead>
              <tr>
                <th scope="col">{t.enumFromLabel}</th>
                <th scope="col">{t.enumToLabel}</th>
              </tr>
            </thead>
            <tbody>
              {(sourceEnum?.values.map((value) => value.name) ?? transform.pairs.map((pair) => pair.from)).map((from) => {
                const pair = transform.pairs.find((item) => item.from === from)
                return (
                  <tr key={from}>
                    <td className="mono">{from}</td>
                    <td>
                      <select
                        className="select"
                        aria-label={`${t.enumToLabel}: ${from}`}
                        value={pair?.to ?? ''}
                        onChange={(event) => {
                          const pairs = transform.pairs.filter((item) => item.from !== from)
                          if (event.target.value) pairs.push({ from, to: event.target.value })
                          update(setTransform(set, mapping.id, field.target, { ...transform, pairs }))
                        }}
                      >
                        <option value="">—</option>
                        {targetEnum?.values.map((value) => (
                          <option key={value.name} value={value.name}>
                            {value.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <label className="field">
            <span>{t.enumFallbackLabel}</span>
            <select
              className="select"
              value={transform.fallback ?? ''}
              onChange={(event) => {
                const next = { ...transform }
                if (event.target.value) next.fallback = event.target.value
                else delete next.fallback
                update(setTransform(set, mapping.id, field.target, next))
              }}
            >
              <option value="">{t.enumFallbackError}</option>
              {targetEnum?.values.map((value) => (
                <option key={value.name} value={value.name}>
                  {value.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {transform.kind === 'expression' && (
        <div className="field-editor__section">
          <label className="field">
            <span>{t.expressionLabel}</span>
            <textarea
              className="textarea"
              rows={2}
              spellCheck={false}
              value={transform.expression}
              aria-describedby={`${id}-expression-help`}
              onChange={(event) => update(setExpression(set, mapping.id, field.target, event.target.value))}
            />
          </label>
          {expressionError && (
            <p className="field__error" role="alert">
              {t.expressionError(expressionError)}
            </p>
          )}
          <p id={`${id}-expression-help`} className="field__hint">
            {t.expressionHelp}
          </p>
        </div>
      )}

      {transform.kind !== 'constant' && (
        <div className="field-editor__grid">
          <label className="field">
            <span>{t.fallbackLabel}</span>
            {targetEnum || isPrimitive(targetField.type, 'boolean') ? (
              <select
                className="select"
                value={field.fallback === undefined || field.fallback === null ? '' : String(field.fallback)}
                onChange={(event) =>
                  update(
                    setFallback(
                      set,
                      mapping.id,
                      field.target,
                      event.target.value === '' ? undefined : parseValue(event.target.value, targetField.type),
                    ),
                  )
                }
              >
                <option value="">{t.fallbackNone}</option>
                {(targetEnum ? targetEnum.values.map((value) => value.name) : ['true', 'false']).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input input--mono"
                type={isNumber(targetField.type) ? 'number' : 'text'}
                value={field.fallback === undefined || field.fallback === null ? '' : String(field.fallback)}
                placeholder={t.fallbackHint}
                onChange={(event) => update(setFallback(set, mapping.id, field.target, parseValue(event.target.value, targetField.type)))}
              />
            )}
          </label>
        </div>
      )}

      <div className="field-editor__actions actions">
        {field.status === 'pending' && (
          <button type="button" className="button button--primary" onClick={() => update(acceptCandidate(set, mapping.id, field.target))}>
            {t.accept}
          </button>
        )}
        <button
          type="button"
          className="button"
          onClick={() => update(ignoreTarget(set, mapping.id, field.target))}
          disabled={field.status === 'ignored'}
        >
          {t.ignoreField}
        </button>
        <button type="button" className="button" onClick={() => update(resetField(set, source, target, mapping.id, field.target))}>
          {t.resetField}
        </button>
      </div>
    </div>
  )
}
