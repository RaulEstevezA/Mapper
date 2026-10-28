import { singularize } from '../../model/naming.ts'
import { failure, type InputParser } from '../types.ts'
import { typedCell } from './csv.ts'
import type { JsonValue } from './jsonText.ts'
import { fromDataValue } from './json.ts'

/** Element as a value: attributes and child elements become keys, repeated children become arrays and
 * text becomes a typed value (`<age>42</age>` is a number). Namespace prefixes are dropped. */
function elementValue(element: Element): JsonValue {
  const children = Array.from(element.children)
  const attributes = Array.from(element.attributes).filter((attribute) => !attribute.name.startsWith('xmlns'))
  if (children.length === 0 && attributes.length === 0) return typedCell(element.textContent ?? '')

  // <items><item/><item/></items>: a wrapper around a list, even when it holds a single element
  const names = children.map((child) => child.localName)
  const single = names.length > 0 && names.every((name) => name === names[0])
  if (
    attributes.length === 0 &&
    single &&
    (names.length > 1 || singularize(element.localName) === names[0]) &&
    element.localName !== names[0]
  ) {
    return { kind: 'array', items: children.map(elementValue) }
  }

  const entries: [string, JsonValue][] = attributes.map((attribute) => [attribute.localName, typedCell(attribute.value)])
  const grouped = new Map<string, Element[]>()
  for (const child of children) grouped.set(child.localName, [...(grouped.get(child.localName) ?? []), child])
  for (const [name, group] of grouped) {
    entries.push([name, group.length > 1 ? { kind: 'array', items: group.map(elementValue) } : elementValue(group[0])])
  }
  const text = Array.from(element.childNodes)
    .filter((node) => node.nodeType === 3 || node.nodeType === 4)
    .map((node) => node.textContent ?? '')
    .join('')
    .trim()
  if (text !== '') entries.push(['value', typedCell(text)])
  return { kind: 'object', entries }
}

export const xmlParser: InputParser = {
  id: 'xml',
  kind: 'data',
  label: 'XML',
  extensions: ['.xml'],
  editorLanguage: 'xml',
  detect(text) {
    const trimmed = text.trimStart()
    if (trimmed.startsWith('<?xml')) return 0.95
    return /^<[A-Za-z_][\w.:-]*[\s>/]/.test(trimmed) ? 0.8 : 0
  },
  parse(text, options = {}) {
    if (text.trim() === '') return failure('empty')
    const document = new DOMParser().parseFromString(text, 'application/xml')
    const error = document.getElementsByTagName('parsererror')[0]
    if (error) {
      const message = (error.textContent ?? '').trim().split('\n')[0]
      const position = /line (?:number )?(\d+)(?:,? (?:at )?column (\d+))?/i.exec(message)
      return failure('syntax', position ? { line: Number(position[1]), column: Number(position[2] ?? 1) } : undefined, { message })
    }
    const root = document.documentElement
    // The root element names the model: XML always has a name of its own
    const name = root.localName || options.rootName || 'Root'
    let value = elementValue(root)
    if (value.kind !== 'object' && value.kind !== 'array') value = { kind: 'object', entries: [['value', value]] }
    return fromDataValue(value, name, 'xml')
  },
}
