import type { ExpressionError } from '../core/transform/expression.ts'
import type { DiagnosticCode } from '../core/mapping/validate.ts'
import type { Confidence, Reason, Transform } from '../core/mapping/types.ts'
import type { ParseIssue } from '../core/parsers/types.ts'
import type { GenerationNote } from '../core/generate/types.ts'
import type { ExampleId } from '../examples/index.ts'

type Params = Record<string, string | number> | undefined
const p = (params: Params, key: string) => String(params?.[key] ?? '')

/** Number with the language's thousands separator. */
const number = (locale: string) => (value: number) => value.toLocaleString(locale)
const en$ = number('en')
const es$ = number('es')

const JSON_DETAIL_EN: Record<string, string> = {
  'json.unexpectedEnd': 'The JSON ends too early: something is not closed.',
  'json.unexpectedCharacter': 'Unexpected character.',
  'json.trailingComma': 'Comma before the end of a list or object: remove it.',
  'json.invalidNumber': 'Invalid number: JSON does not allow leading zeros or a dot without decimals.',
  'json.invalidEscape': 'Unknown escape sequence.',
  'json.controlCharacter': 'Line break or tab inside a text: write it as \\n or \\t.',
  'json.trailingContent': 'There is more text after the end of the JSON.',
  'json.tooDeep': 'The JSON is nested too deeply.',
  modelSchema: 'This model schema is not valid.',
}

const JSON_DETAIL_ES: Record<string, string> = {
  'json.unexpectedEnd': 'El JSON termina antes de tiempo: algo no está cerrado.',
  'json.unexpectedCharacter': 'Carácter inesperado.',
  'json.trailingComma': 'Coma antes del final de una lista u objeto: quítala.',
  'json.invalidNumber': 'Número no válido: JSON no admite ceros a la izquierda ni un punto sin decimales.',
  'json.invalidEscape': 'Secuencia de escape desconocida.',
  'json.controlCharacter': 'Salto de línea o tabulador dentro de un texto: escríbelo como \\n o \\t.',
  'json.trailingContent': 'Hay más texto después del final del JSON.',
  'json.tooDeep': 'El JSON tiene demasiados niveles.',
  modelSchema: 'Este esquema de modelos no es válido.',
}

const en = {
  tagline: 'Relate two data models and generate the code that converts one into the other',
  introDescription:
    'Paste or open the source and the target (classes, DTOs, JSON, schemas), review the relations Mapper suggests field by field, adjust the transformations and get the mapping code for TypeScript, Python, Java, C#, Kotlin, Dart, Swift, Go, Rust or PHP.',
  privacyShort: 'Processed locally',
  privacyPoints: [
    'What you paste or open never leaves your browser.',
    'Code is analyzed, never run.',
    'Nothing is saved unless you turn on “Remember in this browser”.',
  ],
  examplesLabel: 'Try an example',
  examples: {
    simple: 'Simple mapping',
    names: 'Different names',
    nested: 'Nested objects',
    transformations: 'Transformations',
    arrays: 'Lists',
  } satisfies Record<ExampleId, string>,
  exampleDescriptions: {
    simple: 'TypeScript DTO to TypeScript model',
    names: 'JSON in snake_case to a Kotlin data class',
    nested: 'Java classes to C# with flattened fields',
    transformations: 'TypeScript to Pydantic: concatenation, cents, enums, dates',
    arrays: 'JSON order with items to Java records',
  } satisfies Record<ExampleId, string>,
  languageLabel: 'Language',
  license: 'MIT License',
  sourceCode: 'Source code',
  introCode: 'Source code',
  introAllTools: 'All tools',
  api2classNote: 'Starting from a JSON response? Generate its models with Api2Class first and open them here.',
  api2classLink: 'Open Api2Class',
  workspaceTabs: 'Workspace',
  tabs: { source: 'Source', target: 'Target', mapping: 'Relations', code: 'Code' },

  // Inputs
  sourceTitle: 'Source',
  targetTitle: 'Target',
  sourceLabel: 'Source model to analyze',
  targetLabel: 'Target model to analyze',
  inputPlaceholder: 'Paste a class, DTO, JSON or schema here, or drop a file…',
  openFile: 'Open',
  clear: 'Clear',
  create: 'Create',
  createUnavailable: 'Paste or open the source first: the new model starts from its fields.',
  createTitle: 'Create the target model',
  createDescription: (source: string) =>
    `Mapper writes here a model with the fields of “${source}”, in the conventions of the format you choose. Then edit it as text: remove, rename or retype what you need.`,
  createFormat: 'Format of the new model',
  createReplace: 'It replaces the current target.',
  createConfirm: 'Create',
  cancel: 'Cancel',
  created: (model: string, source: string) => `Target model “${model}” created from “${source}”. Edit it in the Target panel.`,
  formatLabel: 'Format',
  formatAuto: (detected: string | null) => (detected ? `Detect (${detected})` : 'Detect automatically'),
  modelLabel: 'Model',
  dropFile: 'Drop the file to open it',
  fileTooLarge: (name: string) => `“${name}” is larger than 10 MB.`,
  fileError: (name: string) => `“${name}” could not be read.`,
  receivedFrom: (tool: string) => `Model received from ${tool}.`,
  inputEmpty: 'Paste or open a model to start.',
  undetected: 'The format could not be detected: choose it in the list.',
  inputSummary: (format: string, models: number, fields: number) =>
    `${format} · ${en$(models)} ${models === 1 ? 'model' : 'models'} · ${en$(fields)} ${fields === 1 ? 'field' : 'fields'}`,
  warningsCount: (count: number) => `${en$(count)} ${count === 1 ? 'note' : 'notes'}`,
  errorPosition: (line: number, column: number) => `Line ${en$(line)}, column ${en$(column)}`,
  parseIssue: (issue: ParseIssue): string => {
    const params = issue.params
    switch (issue.code) {
      case 'empty':
        return 'There is nothing to read.'
      case 'syntax':
        return params?.detail
          ? (JSON_DETAIL_EN[String(params.detail)] ?? String(params.detail)) + (params.path ? ` (${p(params, 'path')})` : '')
          : `Not valid: ${p(params, 'message')}`
      case 'unexpectedToken':
        return `Unexpected “${p(params, 'found')}”.`
      case 'unterminatedString':
        return 'A text (string) is not closed.'
      case 'unterminatedComment':
        return 'A comment is not closed.'
      case 'unclosedBlock':
        return 'A block is not closed.'
      case 'noModels':
        return 'No model was found: paste a class, a type, a JSON object or a schema.'
      case 'unknownType':
        return `Unknown type “${p(params, 'type')}”: it is mapped as it is.`
      case 'mixedTypes':
        return `“${p(params, 'field')}” has values of different types: it is read as any value.`
      case 'duplicateField':
        return `“${p(params, 'field')}” appears twice in ${p(params, 'model')}: the first one is used.`
      case 'duplicateModel':
        return `${p(params, 'model')} is declared twice: the first one is used.`
      case 'emptyModel':
        return `${p(params, 'model')} has no fields.`
      case 'truncatedRows':
        return `Only the first ${p(params, 'rows')} rows were read to infer the columns.`
    }
  },

  // Mapping
  mappingTitle: 'Relations',
  mappingEmpty: 'Paste or open the source and the target, or load an example, and the relations will appear here.',
  mappingWaiting: (side: 'source' | 'target'): string =>
    side === 'source' ? 'The relations will appear when the source can be read.' : 'The relations will appear when the target can be read.',
  summary: {
    total: (count: number) => `${en$(count)} target ${count === 1 ? 'field' : 'fields'}`,
    mapped: (count: number) => `${en$(count)} mapped`,
    review: (count: number) => `${en$(count)} to review`,
    conflict: (count: number) => `${en$(count)} ${count === 1 ? 'conflict' : 'conflicts'}`,
    unmapped: (count: number) => `${en$(count)} without value`,
    ignored: (count: number) => `${en$(count)} ignored`,
  },
  filters: { all: 'All', mapped: 'Mapped', review: 'To review', unmapped: 'Without value', warnings: 'With warnings' },
  filterLabel: 'Show',
  searchLabel: 'Find a field',
  searchPlaceholder: 'Find a field…',
  noResults: 'No field matches the filter.',
  acceptReviews: (count: number) => `Accept ${en$(count)} ${count === 1 ? 'suggestion' : 'suggestions'}`,
  restoreSuggestions: 'Restore suggestions',
  restoreConfirm: 'Restore the suggestions of this model? Your changes to its fields are discarded.',
  undo: 'Undo',
  redo: 'Redo',
  undoTitle: 'Undo (Ctrl/Cmd+Z)',
  redoTitle: 'Redo (Ctrl/Cmd+Shift+Z)',
  columns: { source: 'Source', transform: 'Transformation', target: 'Target', status: 'Status' },
  nested: (source: string, target: string) => `${source} → ${target}`,
  requiredBadge: 'required',
  root: 'whole source',
  noSource: 'no value',
  status: {
    exact: 'Exact',
    high: 'High',
    probable: 'Likely',
    review: 'Review',
    conflict: 'Conflict',
    none: 'No match',
    manual: 'Manual',
    ignored: 'Ignored',
  } satisfies Record<Confidence | 'manual' | 'ignored', string>,
  statusWithScore: (label: string, score: number) => `${label} · ${Math.floor(score * 100)}%`,
  reason: (reason: Reason): string => {
    const params = reason.params
    switch (reason.code) {
      case 'sameName':
        return 'Same name.'
      case 'sameWords':
        return 'Same name in another naming convention.'
      case 'serializedName':
        return 'Same name on the wire (JSON property or column).'
      case 'modelContext':
        return 'Same name once the model name is taken into account.'
      case 'synonym':
        return 'Names with the same meaning.'
      case 'abbreviation':
        return 'One name is an abbreviation or compound of the other.'
      case 'similarName':
        return `Similar names (${p(params, 'similarity')}%).`
      case 'containsName':
        return 'One name contains the other.'
      case 'flattened':
        return `Read from the nested field ${p(params, 'path')}.`
      case 'typeConversion':
        return 'The type is converted.'
      case 'typeFallible':
        return 'The value is converted from text: invalid text fails.'
      case 'typeLossy':
        return 'The conversion may lose precision.'
      case 'typeTransform':
        return 'The types need a transformation.'
      case 'nullToRequired':
        return 'The source may be missing, but the target field is required.'
      case 'nestedModel':
        return 'Both are objects: mapped with their own relations.'
      case 'collection':
        return 'Lists mapped element by element.'
      case 'combined':
        return 'Built by joining several fields.'
      case 'split':
        return 'Taken from part of another field.'
      case 'cents':
        return 'An amount in cents divided by 100.'
      case 'builtFromRoot':
        return 'Built from fields of the source itself.'
    }
  },
  transform: {
    direct: 'Direct',
    concat: 'Join',
    split: 'Part of a text',
    constant: 'Constant value',
    boolean: 'Text to true / false',
    enum: 'Value list',
    epoch: 'Timestamp ↔ date',
    arithmetic: 'Arithmetic',
    object: 'Nested object',
    collection: 'List',
    expression: 'Custom expression',
  } satisfies Record<Transform['kind'], string>,
  transformSummary: (transform: Transform): string => {
    switch (transform.kind) {
      case 'direct':
        return ''
      case 'concat':
        return `with “${transform.separator}”`
      case 'split':
        return transform.part === 0
          ? 'first part'
          : transform.part === 'last'
            ? 'last part'
            : transform.part === 'rest'
              ? 'after the first part'
              : `part ${transform.part + 1}`
      case 'constant':
        return 'constant'
      case 'boolean':
        return transform.trueValues.length > 0 ? `true if ${transform.trueValues.join(', ')}` : 'true if… (to choose)'
      case 'enum':
        return `${transform.pairs.length} ${transform.pairs.length === 1 ? 'value' : 'values'} related`
      case 'epoch':
        return transform.unit === 'seconds' ? 'seconds since 1970' : 'milliseconds since 1970'
      case 'arithmetic':
        return `${transform.operator} ${transform.operand}`
      case 'object':
        return 'nested object'
      case 'collection':
        return 'each element'
      case 'expression':
        return 'expression'
    }
  },
  conversionHint: (from: string, to: string) => `${from} → ${to}`,

  // Field editor
  edit: 'Edit',
  close: 'Close',
  editFieldTitle: (field: string) => `Relation of “${field}”`,
  editFieldLabel: (field: string) => `Edit the relation of “${field}”`,
  accept: 'Accept',
  acceptLabel: (field: string) => `Accept the suggestion for “${field}”`,
  useCandidate: 'Use',
  candidatesTitle: 'Suggestions',
  sourcesLabel: 'Source fields',
  addSource: 'Add field',
  removeSource: (path: string) => `Remove ${path}`,
  chooseSource: 'Choose a field…',
  transformLabel: 'Transformation',
  separatorLabel: 'Separator',
  partLabel: 'Part',
  parts: { first: 'First', last: 'Last', rest: 'After the first' },
  constantLabel: 'Value',
  constantNull: 'empty (null)',
  trueValuesLabel: 'Values that mean true, separated by commas',
  enumFromLabel: 'Source value',
  enumToLabel: 'Target value',
  enumFallbackLabel: 'Values without a pair',
  enumFallbackError: 'Fail (error in the code)',
  epochUnitLabel: 'Unit',
  epochUnits: { seconds: 'Seconds', milliseconds: 'Milliseconds' },
  operatorLabel: 'Operation',
  operandLabel: 'Number',
  expressionLabel: 'Expression',
  expressionHelp:
    'Fields by name (address.city), numbers, "texts", + - * / %, comparisons, && || !, a ?? b, condition ? a : b and upper, lower, trim, length, concat, substring, replace, round, floor, ceil, abs, min, max, toString, toNumber. It is translated to the chosen language, never run here.',
  expressionError: (error: ExpressionError): string => {
    const params = error.params
    switch (error.code) {
      case 'empty':
        return 'Write an expression.'
      case 'unexpectedToken':
        return `Column ${error.column}: unexpected “${p(params, 'found')}”${params?.expected ? `, expected “${p(params, 'expected')}”` : ''}.`
      case 'unterminatedString':
        return `Column ${error.column}: a text is not closed.`
      case 'unknownFunction':
        return `“${p(params, 'name')}” is not one of the available functions.`
      case 'argumentCount':
        return `${p(params, 'name')} needs at least ${p(params, 'count')} ${Number(params?.count) === 1 ? 'value' : 'values'}.`
      case 'unknownField':
        return `The source has no field “${p(params, 'field')}”.`
      case 'typeMismatch':
        return `${p(params, 'operator')} expects ${p(params, 'expected')} but gets ${p(params, 'found')}.`
      case 'tooComplex':
        return 'The expression is too long or too nested.'
    }
  },
  fallbackLabel: 'If the source is missing, use',
  fallbackNone: 'Nothing',
  fallbackHint: 'Leave empty to keep it missing.',
  ignoreField: 'Leave without value',
  resetField: 'Restore suggestion',
  rejectSuggestion: 'Reject',

  // Unused sources and diagnostics
  unusedTitle: (count: number) => `Source fields not used (${en$(count)})`,
  unusedHint: 'Not an error: mark them as ignored once reviewed.',
  markIgnored: 'Mark as ignored',
  unmarkIgnored: 'Use again',
  ignoredSource: 'ignored',
  diagnosticsTitle: 'Checks',
  diagnosticsSummary: (errors: number, warnings: number, info: number) =>
    [
      errors ? `${en$(errors)} ${errors === 1 ? 'error' : 'errors'}` : '',
      warnings ? `${en$(warnings)} ${warnings === 1 ? 'warning' : 'warnings'}` : '',
      info ? `${en$(info)} ${info === 1 ? 'note' : 'notes'}` : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'No problems found',
  severity: { error: 'Error', warning: 'Warning', info: 'Note' },
  diagnostic: (code: DiagnosticCode, field: string, params: Params): string => {
    switch (code) {
      case 'requiredMissing':
        return `“${field}” is required and gets no value. Choose a source, a constant or a default value.`
      case 'unknownSource':
        return `“${field}” uses ${p(params, 'path')}, which is not in the source any more.`
      case 'incompatibleType':
        return `“${field}”: the source type cannot become the target type.`
      case 'needsTransform':
        return `“${field}”: the types need a transformation (choose one).`
      case 'sourceCount':
        return `“${field}”: this transformation needs a different number of source fields.`
      case 'transformType':
        return `“${field}”: the transformation does not suit these types.`
      case 'booleanValues':
        return `“${field}”: say which values mean true.`
      case 'invalidExpression':
        return `“${field}”: the expression is not valid.`
      case 'unresolvedObject':
        return `“${field}”: the nested object has no relations defined.`
      case 'constantType':
        return `“${field}”: the constant does not have the type of the field.`
      case 'nullToRequired':
        return `“${field}”: the source may be missing but the field is required. Add a default value or accept that it fails.`
      case 'fallibleConversion':
        return `“${field}”: converted from text; text that is not valid fails at run time.`
      case 'lossyConversion':
        return `“${field}”: the conversion may lose precision.`
      case 'enumIncomplete':
        return `“${field}”: ${p(params, 'values')} ${Number(params?.count) === 1 ? 'has' : 'have'} no target value. Relate ${Number(params?.count) === 1 ? 'it' : 'them'} or choose a value for the rest.`
      case 'pendingSuggestion':
        return `“${field}”: suggestion waiting for review.`
      case 'conflictPending':
        return `“${field}”: several sources fit; choose one.`
      case 'unusedSource':
        return `${p(params, 'field')} is not used.`
      case 'optionalUnmapped':
        return `“${field}” gets no value (it is optional).`
      case 'conversion':
        return `“${field}”: the type is converted automatically.`
      case 'sharedSource':
        return `${p(params, 'path')} fills ${p(params, 'count')} target fields.`
    }
  },

  // Code
  codeTitle: 'Generated code',
  codeLanguage: 'Output language',
  codeMode: 'Style',
  modes: {
    functions: 'Functions',
    manual: 'Manual mapping',
    mapstruct: 'MapStruct',
    automapper: 'AutoMapper',
    extensions: 'Extensions',
    from: 'From trait',
    static: 'Static methods',
  } as Record<string, string>,
  namingLabel: 'Field names',
  namings: { auto: 'Automatic', keep: 'As in the input', convention: 'Language convention' },
  optionLabels: {
    sourceModule: 'Source models module',
    targetModule: 'Target models module',
    modelsModule: 'Models module',
    sourceAccess: 'Read the source',
    targetStyle: 'Build the target',
    package: 'Package',
    namespace: 'Namespace',
    componentModel: 'Component model',
    modelsImport: 'Models import',
    modelsPath: 'Models path',
  } as Record<string, string>,
  choiceLabels: {
    attribute: 'Attributes',
    dict: 'Dictionary',
    constructor: 'Constructor',
    object: 'Object',
    array: 'Array',
    default: 'None',
    spring: 'Spring',
    cdi: 'CDI',
    jakarta: 'Jakarta',
  } as Record<string, string>,
  codeLabel: (language: string) => `Generated ${language} code`,
  codeEmpty: 'The mapping code will appear here when there are relations.',
  files: 'Files',
  copy: 'Copy',
  copied: 'Copied',
  download: 'Download',
  downloadZip: (count: number) => `Download ${en$(count)} files`,
  note: (note: GenerationNote): string => {
    const field = p(note.params, 'field')
    switch (note.code) {
      case 'missingValue':
        return `“${field}” has no value: the code has a placeholder marked TODO.`
      case 'unsafeNull':
        return `“${field}” is required but the source may be missing: the code fails in that case.`
      case 'enumFallbackThrows':
        return `Values of ${p(note.params, 'enum')} without a pair fail at run time.`
      case 'namesConverted':
        return 'Field names were converted to the language convention.'
      case 'fallibleConversion':
        return `“${field}” is converted from text and may fail.`
      case 'expressionApproximation':
        return `The expression of “${field}” was adapted to the language.`
    }
  },
  notesCount: (count: number) => `${en$(count)} ${count === 1 ? 'thing' : 'things'} to check in the code`,

  // Project
  projectActions: 'Project',
  saveProject: 'Save project',
  openProject: 'Open project',
  exportTarget: 'Export target model',
  exportTargetTitle: 'Model schema of the target, for DBCreate or another tool',
  projectLoaded: (name: string) => `Project “${name}” opened.`,
  projectError: (error: 'notJson' | 'notProject' | 'newerVersion' | 'invalid', path?: string): string => {
    switch (error) {
      case 'notJson':
        return 'The file is not a Mapper project (it is not JSON).'
      case 'notProject':
        return 'The file is not a Mapper project.'
      case 'newerVersion':
        return 'The project was saved by a newer version of Mapper.'
      case 'invalid':
        return `The project is damaged${path ? ` (${path})` : ''}.`
    }
  },
  remember: 'Remember in this browser',
  rememberHint: 'Saves your inputs and relations in this browser only, to continue later.',
  clearSaved: 'Delete saved work',
  clearSavedConfirm: 'Delete the work saved in this browser?',
  savedCleared: 'Saved work deleted.',
  restored: 'Your previous work was restored from this browser.',
  confirmReplace: 'Replace the current inputs and relations?',
}

export type Messages = typeof en

const es: Messages = {
  tagline: 'Relaciona dos modelos de datos y genera el código que convierte uno en el otro',
  introDescription:
    'Pega o abre el origen y el destino (clases, DTOs, JSON, esquemas), revisa las relaciones que propone Mapper campo a campo, ajusta las transformaciones y obtén el código de mapping para TypeScript, Python, Java, C#, Kotlin, Dart, Swift, Go, Rust o PHP.',
  privacyShort: 'Procesado en local',
  privacyPoints: [
    'Lo que pegas o abres no sale del navegador.',
    'El código se analiza, nunca se ejecuta.',
    'No se guarda nada salvo que actives «Recordar en este navegador».',
  ],
  examplesLabel: 'Prueba un ejemplo',
  examples: {
    simple: 'Mapping simple',
    names: 'Nombres distintos',
    nested: 'Objetos anidados',
    transformations: 'Transformaciones',
    arrays: 'Listas',
  },
  exampleDescriptions: {
    simple: 'DTO de TypeScript a modelo de TypeScript',
    names: 'JSON en snake_case a una data class de Kotlin',
    nested: 'Clases de Java a C# con campos aplanados',
    transformations: 'TypeScript a Pydantic: concatenación, céntimos, enums, fechas',
    arrays: 'Pedido JSON con líneas a records de Java',
  },
  languageLabel: 'Idioma',
  license: 'Licencia MIT',
  sourceCode: 'Código fuente',
  introCode: 'Código fuente',
  introAllTools: 'Todas las herramientas',
  api2classNote: '¿Partes de una respuesta JSON? Genera antes sus modelos con Api2Class y ábrelos aquí.',
  api2classLink: 'Abrir Api2Class',
  workspaceTabs: 'Área de trabajo',
  tabs: { source: 'Origen', target: 'Destino', mapping: 'Relaciones', code: 'Código' },

  sourceTitle: 'Origen',
  targetTitle: 'Destino',
  sourceLabel: 'Modelo de origen para analizar',
  targetLabel: 'Modelo de destino para analizar',
  inputPlaceholder: 'Pega aquí una clase, un DTO, un JSON o un esquema, o suelta un archivo…',
  openFile: 'Abrir',
  clear: 'Limpiar',
  create: 'Crear',
  createUnavailable: 'Pega o abre antes el origen: el modelo nuevo parte de sus campos.',
  createTitle: 'Crear el modelo de destino',
  createDescription: (source) =>
    `Mapper escribe aquí un modelo con los campos de «${source}», con las convenciones del formato que elijas. Después edítalo como texto: quita, renombra o cambia el tipo de lo que necesites.`,
  createFormat: 'Formato del modelo nuevo',
  createReplace: 'Sustituye el destino actual.',
  createConfirm: 'Crear',
  cancel: 'Cancelar',
  created: (model, source) => `Modelo de destino «${model}» creado a partir de «${source}». Edítalo en el panel Destino.`,
  formatLabel: 'Formato',
  formatAuto: (detected) => (detected ? `Detectar (${detected})` : 'Detectar automáticamente'),
  modelLabel: 'Modelo',
  dropFile: 'Suelta el archivo para abrirlo',
  fileTooLarge: (name) => `“${name}” supera los 10 MB.`,
  fileError: (name) => `“${name}” no se ha podido leer.`,
  receivedFrom: (tool) => `Modelo recibido de ${tool}.`,
  inputEmpty: 'Pega o abre un modelo para empezar.',
  undetected: 'No se ha podido detectar el formato: elígelo en la lista.',
  inputSummary: (format, models, fields) =>
    `${format} · ${es$(models)} ${models === 1 ? 'modelo' : 'modelos'} · ${es$(fields)} ${fields === 1 ? 'campo' : 'campos'}`,
  warningsCount: (count) => `${es$(count)} ${count === 1 ? 'aviso' : 'avisos'}`,
  errorPosition: (line, column) => `Línea ${es$(line)}, columna ${es$(column)}`,
  parseIssue: (issue) => {
    const params = issue.params
    switch (issue.code) {
      case 'empty':
        return 'No hay nada que leer.'
      case 'syntax':
        return params?.detail
          ? (JSON_DETAIL_ES[String(params.detail)] ?? String(params.detail)) + (params.path ? ` (${p(params, 'path')})` : '')
          : `No es válido: ${p(params, 'message')}`
      case 'unexpectedToken':
        return `“${p(params, 'found')}” inesperado.`
      case 'unterminatedString':
        return 'Un texto (string) no está cerrado.'
      case 'unterminatedComment':
        return 'Un comentario no está cerrado.'
      case 'unclosedBlock':
        return 'Un bloque no está cerrado.'
      case 'noModels':
        return 'No se ha encontrado ningún modelo: pega una clase, un tipo, un objeto JSON o un esquema.'
      case 'unknownType':
        return `Tipo desconocido “${p(params, 'type')}”: se relaciona tal cual.`
      case 'mixedTypes':
        return `“${p(params, 'field')}” tiene valores de tipos distintos: se lee como cualquier valor.`
      case 'duplicateField':
        return `“${p(params, 'field')}” aparece dos veces en ${p(params, 'model')}: se usa el primero.`
      case 'duplicateModel':
        return `${p(params, 'model')} está declarado dos veces: se usa el primero.`
      case 'emptyModel':
        return `${p(params, 'model')} no tiene campos.`
      case 'truncatedRows':
        return `Solo se han leído las primeras ${p(params, 'rows')} filas para deducir las columnas.`
    }
  },

  mappingTitle: 'Relaciones',
  mappingEmpty: 'Pega o abre el origen y el destino, o carga un ejemplo, y las relaciones aparecerán aquí.',
  mappingWaiting: (side) =>
    side === 'source'
      ? 'Las relaciones aparecerán cuando se pueda leer el origen.'
      : 'Las relaciones aparecerán cuando se pueda leer el destino.',
  summary: {
    total: (count) => `${es$(count)} ${count === 1 ? 'campo' : 'campos'} de destino`,
    mapped: (count) => `${es$(count)} ${count === 1 ? 'asignado' : 'asignados'}`,
    review: (count) => `${es$(count)} para revisar`,
    conflict: (count) => `${es$(count)} ${count === 1 ? 'conflicto' : 'conflictos'}`,
    unmapped: (count) => `${es$(count)} sin valor`,
    ignored: (count) => `${es$(count)} ${count === 1 ? 'ignorado' : 'ignorados'}`,
  },
  filters: { all: 'Todos', mapped: 'Asignados', review: 'Para revisar', unmapped: 'Sin valor', warnings: 'Con avisos' },
  filterLabel: 'Mostrar',
  searchLabel: 'Buscar un campo',
  searchPlaceholder: 'Buscar un campo…',
  noResults: 'Ningún campo coincide con el filtro.',
  acceptReviews: (count) => `Aceptar ${es$(count)} ${count === 1 ? 'sugerencia' : 'sugerencias'}`,
  restoreSuggestions: 'Restaurar sugerencias',
  restoreConfirm: '¿Restaurar las sugerencias de este modelo? Se descartan tus cambios en sus campos.',
  undo: 'Deshacer',
  redo: 'Rehacer',
  undoTitle: 'Deshacer (Ctrl/Cmd+Z)',
  redoTitle: 'Rehacer (Ctrl/Cmd+Mayús+Z)',
  columns: { source: 'Origen', transform: 'Transformación', target: 'Destino', status: 'Estado' },
  nested: (source, target) => `${source} → ${target}`,
  requiredBadge: 'obligatorio',
  root: 'el origen completo',
  noSource: 'sin valor',
  status: {
    exact: 'Exacta',
    high: 'Alta',
    probable: 'Probable',
    review: 'Revisar',
    conflict: 'Conflicto',
    none: 'Sin coincidencia',
    manual: 'Manual',
    ignored: 'Ignorado',
  },
  statusWithScore: (label, score) => `${label} · ${Math.floor(score * 100)} %`,
  reason: (reason) => {
    const params = reason.params
    switch (reason.code) {
      case 'sameName':
        return 'Mismo nombre.'
      case 'sameWords':
        return 'Mismo nombre en otra convención.'
      case 'serializedName':
        return 'Mismo nombre en el formato de intercambio (propiedad JSON o columna).'
      case 'modelContext':
        return 'Mismo nombre teniendo en cuenta el nombre del modelo.'
      case 'synonym':
        return 'Nombres con el mismo significado.'
      case 'abbreviation':
        return 'Un nombre es una abreviatura o compuesto del otro.'
      case 'similarName':
        return `Nombres parecidos (${p(params, 'similarity')} %).`
      case 'containsName':
        return 'Un nombre contiene al otro.'
      case 'flattened':
        return `Leído del campo anidado ${p(params, 'path')}.`
      case 'typeConversion':
        return 'El tipo se convierte.'
      case 'typeFallible':
        return 'El valor se convierte desde texto: un texto no válido falla.'
      case 'typeLossy':
        return 'La conversión puede perder precisión.'
      case 'typeTransform':
        return 'Los tipos necesitan una transformación.'
      case 'nullToRequired':
        return 'El origen puede faltar, pero el campo de destino es obligatorio.'
      case 'nestedModel':
        return 'Los dos son objetos: se relacionan con sus propias relaciones.'
      case 'collection':
        return 'Listas relacionadas elemento a elemento.'
      case 'combined':
        return 'Se construye uniendo varios campos.'
      case 'split':
        return 'Se toma de una parte de otro campo.'
      case 'cents':
        return 'Un importe en céntimos dividido entre 100.'
      case 'builtFromRoot':
        return 'Se construye con campos del propio origen.'
    }
  },
  transform: {
    direct: 'Directa',
    concat: 'Unir',
    split: 'Parte de un texto',
    constant: 'Valor constante',
    boolean: 'Texto a verdadero / falso',
    enum: 'Lista de valores',
    epoch: 'Marca de tiempo ↔ fecha',
    arithmetic: 'Aritmética',
    object: 'Objeto anidado',
    collection: 'Lista',
    expression: 'Expresión personalizada',
  },
  transformSummary: (transform) => {
    switch (transform.kind) {
      case 'direct':
        return ''
      case 'concat':
        return `con «${transform.separator}»`
      case 'split':
        return transform.part === 0
          ? 'primera parte'
          : transform.part === 'last'
            ? 'última parte'
            : transform.part === 'rest'
              ? 'tras la primera parte'
              : `parte ${transform.part + 1}`
      case 'constant':
        return 'constante'
      case 'boolean':
        return transform.trueValues.length > 0 ? `verdadero si ${transform.trueValues.join(', ')}` : 'verdadero si… (por elegir)'
      case 'enum':
        return `${transform.pairs.length} ${transform.pairs.length === 1 ? 'valor relacionado' : 'valores relacionados'}`
      case 'epoch':
        return transform.unit === 'seconds' ? 'segundos desde 1970' : 'milisegundos desde 1970'
      case 'arithmetic':
        return `${transform.operator} ${transform.operand}`
      case 'object':
        return 'objeto anidado'
      case 'collection':
        return 'cada elemento'
      case 'expression':
        return 'expresión'
    }
  },
  conversionHint: (from, to) => `${from} → ${to}`,

  edit: 'Editar',
  close: 'Cerrar',
  editFieldTitle: (field) => `Relación de «${field}»`,
  editFieldLabel: (field) => `Editar la relación de «${field}»`,
  accept: 'Aceptar',
  acceptLabel: (field) => `Aceptar la sugerencia para «${field}»`,
  useCandidate: 'Usar',
  candidatesTitle: 'Sugerencias',
  sourcesLabel: 'Campos de origen',
  addSource: 'Añadir campo',
  removeSource: (path) => `Quitar ${path}`,
  chooseSource: 'Elige un campo…',
  transformLabel: 'Transformación',
  separatorLabel: 'Separador',
  partLabel: 'Parte',
  parts: { first: 'Primera', last: 'Última', rest: 'Tras la primera' },
  constantLabel: 'Valor',
  constantNull: 'vacío (null)',
  trueValuesLabel: 'Valores que significan verdadero, separados por comas',
  enumFromLabel: 'Valor de origen',
  enumToLabel: 'Valor de destino',
  enumFallbackLabel: 'Valores sin pareja',
  enumFallbackError: 'Fallar (error en el código)',
  epochUnitLabel: 'Unidad',
  epochUnits: { seconds: 'Segundos', milliseconds: 'Milisegundos' },
  operatorLabel: 'Operación',
  operandLabel: 'Número',
  expressionLabel: 'Expresión',
  expressionHelp:
    'Campos por nombre (address.city), números, "textos", + - * / %, comparaciones, && || !, a ?? b, condición ? a : b y upper, lower, trim, length, concat, substring, replace, round, floor, ceil, abs, min, max, toString, toNumber. Se traduce al lenguaje elegido; nunca se ejecuta aquí.',
  expressionError: (error) => {
    const params = error.params
    switch (error.code) {
      case 'empty':
        return 'Escribe una expresión.'
      case 'unexpectedToken':
        return `Columna ${error.column}: “${p(params, 'found')}” inesperado${params?.expected ? `, se esperaba “${p(params, 'expected')}”` : ''}.`
      case 'unterminatedString':
        return `Columna ${error.column}: un texto no está cerrado.`
      case 'unknownFunction':
        return `“${p(params, 'name')}” no es una de las funciones disponibles.`
      case 'argumentCount':
        return `${p(params, 'name')} necesita al menos ${p(params, 'count')} ${Number(params?.count) === 1 ? 'valor' : 'valores'}.`
      case 'unknownField':
        return `El origen no tiene el campo “${p(params, 'field')}”.`
      case 'typeMismatch':
        return `${p(params, 'operator')} espera ${p(params, 'expected')} pero recibe ${p(params, 'found')}.`
      case 'tooComplex':
        return 'La expresión es demasiado larga o tiene demasiados niveles.'
    }
  },
  fallbackLabel: 'Si falta el origen, usar',
  fallbackNone: 'Nada',
  fallbackHint: 'Déjalo vacío para que siga faltando.',
  ignoreField: 'Dejar sin valor',
  resetField: 'Restaurar sugerencia',
  rejectSuggestion: 'Rechazar',

  unusedTitle: (count) => `Campos de origen sin usar (${es$(count)})`,
  unusedHint: 'No es un error: márcalos como ignorados cuando los hayas revisado.',
  markIgnored: 'Marcar como ignorado',
  unmarkIgnored: 'Volver a usar',
  ignoredSource: 'ignorado',
  diagnosticsTitle: 'Comprobaciones',
  diagnosticsSummary: (errors, warnings, info) =>
    [
      errors ? `${es$(errors)} ${errors === 1 ? 'error' : 'errores'}` : '',
      warnings ? `${es$(warnings)} ${warnings === 1 ? 'aviso' : 'avisos'}` : '',
      info ? `${es$(info)} ${info === 1 ? 'nota' : 'notas'}` : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'No se ha encontrado ningún problema',
  severity: { error: 'Error', warning: 'Aviso', info: 'Nota' },
  diagnostic: (code, field, params) => {
    switch (code) {
      case 'requiredMissing':
        return `«${field}» es obligatorio y no recibe valor. Elige un origen, una constante o un valor por defecto.`
      case 'unknownSource':
        return `«${field}» usa ${p(params, 'path')}, que ya no está en el origen.`
      case 'incompatibleType':
        return `«${field}»: el tipo de origen no puede convertirse en el de destino.`
      case 'needsTransform':
        return `«${field}»: los tipos necesitan una transformación (elige una).`
      case 'sourceCount':
        return `«${field}»: esta transformación necesita otro número de campos de origen.`
      case 'transformType':
        return `«${field}»: la transformación no encaja con estos tipos.`
      case 'booleanValues':
        return `«${field}»: indica qué valores significan verdadero.`
      case 'invalidExpression':
        return `«${field}»: la expresión no es válida.`
      case 'unresolvedObject':
        return `«${field}»: el objeto anidado no tiene relaciones definidas.`
      case 'constantType':
        return `«${field}»: la constante no tiene el tipo del campo.`
      case 'nullToRequired':
        return `«${field}»: el origen puede faltar pero el campo es obligatorio. Añade un valor por defecto o acepta que falle.`
      case 'fallibleConversion':
        return `«${field}»: se convierte desde texto; un texto no válido falla al ejecutarse.`
      case 'lossyConversion':
        return `«${field}»: la conversión puede perder precisión.`
      case 'enumIncomplete':
        return `«${field}»: ${p(params, 'values')} no ${Number(params?.count) === 1 ? 'tiene' : 'tienen'} valor de destino. ${Number(params?.count) === 1 ? 'Relaciónalo' : 'Relaciónalos'} o elige un valor para el resto.`
      case 'pendingSuggestion':
        return `«${field}»: sugerencia pendiente de revisar.`
      case 'conflictPending':
        return `«${field}»: encajan varios orígenes; elige uno.`
      case 'unusedSource':
        return `${p(params, 'field')} no se usa.`
      case 'optionalUnmapped':
        return `«${field}» no recibe valor (es opcional).`
      case 'conversion':
        return `«${field}»: el tipo se convierte automáticamente.`
      case 'sharedSource':
        return `${p(params, 'path')} rellena ${p(params, 'count')} campos de destino.`
    }
  },

  codeTitle: 'Código generado',
  codeLanguage: 'Lenguaje de salida',
  codeMode: 'Estilo',
  modes: {
    functions: 'Funciones',
    manual: 'Mapping manual',
    mapstruct: 'MapStruct',
    automapper: 'AutoMapper',
    extensions: 'Extensiones',
    from: 'Trait From',
    static: 'Métodos estáticos',
  },
  namingLabel: 'Nombres de campos',
  namings: { auto: 'Automático', keep: 'Como en la entrada', convention: 'Convención del lenguaje' },
  optionLabels: {
    sourceModule: 'Módulo de los modelos de origen',
    targetModule: 'Módulo de los modelos de destino',
    modelsModule: 'Módulo de los modelos',
    sourceAccess: 'Leer el origen',
    targetStyle: 'Construir el destino',
    package: 'Paquete',
    namespace: 'Namespace',
    componentModel: 'Modelo de componentes',
    modelsImport: 'Import de los modelos',
    modelsPath: 'Ruta de los modelos',
  },
  choiceLabels: {
    attribute: 'Atributos',
    dict: 'Diccionario',
    constructor: 'Constructor',
    object: 'Objeto',
    array: 'Array',
    default: 'Ninguno',
    spring: 'Spring',
    cdi: 'CDI',
    jakarta: 'Jakarta',
  },
  codeLabel: (language) => `Código ${language} generado`,
  codeEmpty: 'El código de mapping aparecerá aquí cuando haya relaciones.',
  files: 'Archivos',
  copy: 'Copiar',
  copied: 'Copiado',
  download: 'Descargar',
  downloadZip: (count) => `Descargar ${es$(count)} archivos`,
  note: (note) => {
    const field = p(note.params, 'field')
    switch (note.code) {
      case 'missingValue':
        return `«${field}» no tiene valor: el código lleva un marcador TODO.`
      case 'unsafeNull':
        return `«${field}» es obligatorio pero el origen puede faltar: el código falla en ese caso.`
      case 'enumFallbackThrows':
        return `Los valores de ${p(note.params, 'enum')} sin pareja fallan al ejecutarse.`
      case 'namesConverted':
        return 'Los nombres de los campos se han convertido a la convención del lenguaje.'
      case 'fallibleConversion':
        return `«${field}» se convierte desde texto y puede fallar.`
      case 'expressionApproximation':
        return `La expresión de «${field}» se ha adaptado al lenguaje.`
    }
  },
  notesCount: (count) => `${es$(count)} ${count === 1 ? 'cosa' : 'cosas'} que revisar en el código`,

  projectActions: 'Proyecto',
  saveProject: 'Guardar proyecto',
  openProject: 'Abrir proyecto',
  exportTarget: 'Exportar modelo de destino',
  exportTargetTitle: 'Esquema de modelos del destino, para DBCreate u otra herramienta',
  projectLoaded: (name) => `Proyecto «${name}» abierto.`,
  projectError: (error, path) => {
    switch (error) {
      case 'notJson':
        return 'El archivo no es un proyecto de Mapper (no es JSON).'
      case 'notProject':
        return 'El archivo no es un proyecto de Mapper.'
      case 'newerVersion':
        return 'El proyecto se guardó con una versión más reciente de Mapper.'
      case 'invalid':
        return `El proyecto está dañado${path ? ` (${path})` : ''}.`
    }
  },
  remember: 'Recordar en este navegador',
  rememberHint: 'Guarda tus entradas y relaciones solo en este navegador, para seguir más tarde.',
  clearSaved: 'Borrar el trabajo guardado',
  clearSavedConfirm: '¿Borrar el trabajo guardado en este navegador?',
  savedCleared: 'Trabajo guardado borrado.',
  restored: 'Se ha recuperado tu trabajo anterior de este navegador.',
  confirmReplace: '¿Sustituir las entradas y relaciones actuales?',
}

export const messages = { en, es }
export type Language = keyof typeof messages
export const languages = Object.keys(messages) as Language[]
