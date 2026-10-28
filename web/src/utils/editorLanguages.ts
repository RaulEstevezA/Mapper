import { LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language'

const legacy = (parser: StreamParser<unknown>) => new LanguageSupport(StreamLanguage.define(parser))

// Loaded on demand: only the languages being viewed are downloaded
const LOADERS: Record<string, () => Promise<LanguageSupport>> = {
  json: async () => (await import('@codemirror/lang-json')).json(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  php: async () => (await import('@codemirror/lang-php')).php({ plain: false }),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  csharp: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).csharp),
  kotlin: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  dart: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).dart),
  swift: async () => legacy((await import('@codemirror/legacy-modes/mode/swift')).swift),
  protobuf: async () => legacy((await import('@codemirror/legacy-modes/mode/protobuf')).protobuf),
  // GraphQL and Prisma read close enough to Kotlin for highlighting
  graphql: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  prisma: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  text: async () => new LanguageSupport(StreamLanguage.define({ token: (stream) => (stream.skipToEnd(), null) })),
}

const cache = new Map<string, Promise<LanguageSupport>>()

/** Highlighting for an input format or an output language. */
export function editorLanguage(id: string): Promise<LanguageSupport> {
  if (!cache.has(id)) cache.set(id, (LOADERS[id] ?? LOADERS.text)())
  return cache.get(id)!
}
