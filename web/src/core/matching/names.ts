import { nameWords, singularize } from '../model/naming.ts'
import type { ReasonCode } from '../mapping/types.ts'

/** Name comparison for the matching engine. Every rule gives a score from 0 to 1 and the reason, so the
 * interface can explain each suggestion (docs/mapping-engine.md). */

// Abbreviations expanded before comparing (`qty` → quantity)
const ABBREVIATIONS: Record<string, string[]> = {
  qty: ['quantity'],
  amt: ['amount'],
  addr: ['address'],
  desc: ['description'],
  descr: ['description'],
  img: ['image'],
  pic: ['picture'],
  num: ['number'],
  nr: ['number'],
  no: ['number'],
  tel: ['phone'],
  msg: ['message'],
  cnt: ['count'],
  dt: ['date'],
  ts: ['timestamp'],
  dept: ['department'],
  mgr: ['manager'],
  emp: ['employee'],
  cust: ['customer'],
  prod: ['product'],
  acct: ['account'],
  pwd: ['password'],
  pw: ['password'],
  passwd: ['password'],
  info: ['information'],
  ref: ['reference'],
  src: ['source'],
  dst: ['destination'],
  dest: ['destination'],
  lang: ['language'],
  cfg: ['configuration'],
  config: ['configuration'],
  org: ['organization'],
  qtty: ['quantity'],
  fname: ['first', 'name'],
  lname: ['last', 'name'],
  dob: ['birth', 'date'],
  pk: ['id'],
  uid: ['user', 'id'],
}

// Single words that stand for several (`surname` is "last name")
const COMPOUNDS: Record<string, string[]> = {
  surname: ['last', 'name'],
  forename: ['first', 'name'],
  firstname: ['first', 'name'],
  lastname: ['last', 'name'],
  fullname: ['full', 'name'],
  birthday: ['birth', 'date'],
  birthdate: ['birth', 'date'],
  zipcode: ['postal', 'code'],
  zip: ['postal', 'code'],
  postcode: ['postal', 'code'],
  postalcode: ['postal', 'code'],
  phonenumber: ['phone'],
  emailaddress: ['email'],
  mail: ['email'],
  telephone: ['phone'],
  mobile: ['phone'],
  cellphone: ['phone'],
  cell: ['phone'],
  identifier: ['id'],
  createdat: ['created'],
  updatedat: ['updated'],
  timestamp: ['time'],
}

// Words with the same meaning; the first is the canonical one. Strong groups are near certain; weak
// groups are only likely and stay "probable" at most.
const STRONG_SYNONYMS: string[][] = [
  ['created', 'creation', 'create', 'inserted', 'added'],
  ['updated', 'modified', 'changed', 'update', 'modification', 'edited'],
  ['deleted', 'removed', 'deletion'],
  ['given', 'first'],
  ['family', 'last'],
  ['description', 'details'],
  ['url', 'uri', 'link', 'href'],
  ['image', 'picture', 'photo'],
  ['quantity', 'units'],
  ['active', 'enabled'],
  ['comment', 'note', 'notes', 'remarks', 'comments'],
  ['company', 'organization', 'organisation'],
  ['category', 'categories'],
  ['gender', 'sex'],
  ['postal', 'zip'],
]

const WEAK_SYNONYMS: string[][] = [
  ['price', 'cost'],
  ['amount', 'total', 'sum'],
  ['name', 'title', 'label'],
  ['city', 'town', 'locality'],
  ['state', 'province', 'region'],
  ['country', 'nation'],
  ['street', 'line'],
  ['count', 'number', 'total'],
  ['username', 'login', 'handle'],
  ['avatar', 'image'],
  ['customer', 'client'],
  ['product', 'item', 'article'],
  ['item', 'line', 'entry'],
  ['order', 'purchase'],
]

// Words that add no meaning when comparing (`createdAt` and `creation_date` are the same moment)
const STOP_WORDS = new Set(['at', 'on', 'of', 'the', 'a', 'an', 'by', 'in', 'is', 'has', 'was'])
const TEMPORAL = new Set(['date', 'time', 'datetime', 'timestamp', 'when'])
// Keys whose meaning does not change when the model name is added or removed (`userId` in User is `id`)
const KEY_WORDS = new Set(['id', 'key', 'code', 'number', 'uuid', 'guid', 'ref'])

const strongIndex = new Map<string, string>()
for (const group of STRONG_SYNONYMS) for (const word of group) strongIndex.set(word, group[0])
const weakIndex = new Map<string, Set<number>>()
WEAK_SYNONYMS.forEach((group, index) => {
  for (const word of group) weakIndex.set(word, new Set([...(weakIndex.get(word) ?? []), index]))
})

// Phrases that say the same as a shorter one (`emailAddress` is the email, `phoneNumber` the phone)
const PHRASES: [string[], string[]][] = [
  [['email', 'address'], ['email']],
  [['e', 'mail'], ['email']],
  [['phone', 'number'], ['phone']],
  [
    ['zip', 'code'],
    ['postal', 'code'],
  ],
  [
    ['post', 'code'],
    ['postal', 'code'],
  ],
  [['user', 'name'], ['username']],
  [
    ['date', 'birth'],
    ['birth', 'date'],
  ],
]

function collapsePhrases(words: string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < words.length;) {
    const phrase = PHRASES.find(([from]) => from.every((word, offset) => words[index + offset] === word))
    if (phrase) {
      result.push(...phrase[1])
      index += phrase[0].length
    } else result.push(words[index++])
  }
  return result
}

/** Words of a name, expanded: abbreviations, compound words, plurals, phrases. */
export function expandedWords(name: string): string[] {
  return expandWordList(nameWords(name))
}

/** The same for words already split (the words of a path, `address.zipCode`). */
export function expandWordList(words: string[]): string[] {
  return collapsePhrases(
    words.flatMap((word) => {
      if (word in ABBREVIATIONS) return ABBREVIATIONS[word]
      if (word in COMPOUNDS) return COMPOUNDS[word]
      const singular = singularize(word)
      return [singular in COMPOUNDS ? COMPOUNDS[singular] : singular].flat()
    }),
  )
}

// Suffixes of model names that say what the model is for, not what it holds (`UserDto` holds a user)
const MODEL_SUFFIXES = new Set([
  'dto',
  'entity',
  'model',
  'request',
  'response',
  'api',
  'data',
  'record',
  'schema',
  'payload',
  'view',
  'vm',
  'dao',
  'bean',
  'pojo',
  'input',
  'output',
  'resource',
  'details',
  'info',
  'type',
  'object',
  'row',
  'table',
])

/** Words of a model name for context matching, without the role suffixes: `UserDto` → user. */
export function modelWords(name: string): string[] {
  const words = nameWords(name)
  while (words.length > 1 && MODEL_SUFFIXES.has(words[words.length - 1])) words.pop()
  return words
}

/** Words reduced to their meaning: stop words out, synonyms canonical, a trailing "date" or "time"
 * dropped when something else remains (`created_at`, `creation_date` and `createdOn` are all "created"). */
export function meaningWords(words: string[]): string[] {
  let result = words.filter((word) => !STOP_WORDS.has(word)).map((word) => strongIndex.get(word) ?? word)
  while (result.length > 1 && TEMPORAL.has(result[result.length - 1])) result = result.slice(0, -1)
  return result
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sorted = (words: string[]) => [...words].sort().join(' ')
  return sorted(a) === sorted(b)
}

function weakSame(a: string[], b: string[]): boolean {
  if (a.length !== b.length || a.length === 0) return false
  const used = new Set<number>()
  return a.every((word) => {
    const index = b.findIndex((other, position) => {
      if (used.has(position)) return false
      if (other === word) return true
      const groups = weakIndex.get(word)
      return groups !== undefined && [...(weakIndex.get(other) ?? [])].some((group) => groups.has(group))
    })
    if (index === -1) return false
    used.add(index)
    return true
  })
}

/** Jaro-Winkler similarity of two strings, from 0 to 1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatches = new Array<boolean>(a.length).fill(false)
  const bMatches = new Array<boolean>(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++) {
      if (bMatches[j] || a[i] !== b[j]) continue
      aMatches[i] = bMatches[j] = true
      matches++
      break
    }
  }
  if (matches === 0) return 0
  let transpositions = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue
    while (!bMatches[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3
  let prefix = 0
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}

/** Share of words in common (Dice coefficient). */
function dice(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const remaining = [...b]
  let common = 0
  for (const word of a) {
    const index = remaining.indexOf(word)
    if (index >= 0) {
      common++
      remaining.splice(index, 1)
    }
  }
  return (2 * common) / (a.length + b.length)
}

/** How much of the words of one name appear inside the other's (`username` contains `name`). */
function containment(a: string[], b: string[]): number {
  const joinedA = a.join('')
  const joinedB = b.join('')
  const covered = (words: string[], text: string) =>
    words.filter((word) => word.length >= 3 && text.includes(word)).reduce((total, word) => total + word.length, 0)
  const coverA = joinedA.length > 0 ? covered(b, joinedA) / joinedA.length : 0
  const coverB = joinedB.length > 0 ? covered(a, joinedB) / joinedB.length : 0
  return Math.min(1, (coverA + coverB) / 2)
}

export interface NameMatch {
  score: number
  reason: ReasonCode
  /** Similarity as a percentage, for the fuzzy rules */
  similarity?: number
}

export interface NameContext {
  /** Words of the model each field belongs to, to recognize `userId` in User as `id` */
  sourceModel: string[]
  targetModel: string[]
}

function stripModel(words: string[], model: string[]): string[] {
  if (model.length === 0 || words.length <= model.length) return words
  const starts = model.every((word, index) => words[index] === word)
  return starts ? words.slice(model.length) : words
}

/** Scores how well a source name matches a target name. `sourceWords` may come from a path
 * (`address.city` → address city). Returns null when they have nothing in common. */
interface Analysis {
  raw: string
  expanded: string[]
  meaning: string[]
}

// Every name is compared with many others: its words are worked out once
const analyses = new Map<string, Analysis>()

function analyze(words: string[]): Analysis {
  const raw = words.join(' ')
  let analysis = analyses.get(raw)
  if (!analysis) {
    const expanded = expandWordList(words)
    analysis = { raw, expanded, meaning: meaningWords(expanded) }
    // A bound so a long session with many inputs does not keep every name forever
    if (analyses.size > 20000) analyses.clear()
    analyses.set(raw, analysis)
  }
  return analysis
}

export function compareNames(sourceName: string, sourceWords: string[], targetName: string, context: NameContext): NameMatch | null {
  if (sourceName === targetName) return { score: 1, reason: 'sameName' }
  const sourceAnalysis = analyze(sourceWords)
  const targetAnalysis = analyze(nameWords(targetName))
  if (sourceAnalysis.raw === targetAnalysis.raw) return { score: 0.97, reason: 'sameWords' }

  const source = sourceAnalysis.expanded
  const target = targetAnalysis.expanded
  if (sameSet(source, target)) return { score: 0.93, reason: 'abbreviation' }

  const sourceMeaning = sourceAnalysis.meaning
  const targetMeaning = targetAnalysis.meaning
  if (sameSet(sourceMeaning, targetMeaning)) return { score: 0.88, reason: 'synonym' }

  // The model name added to a key: `id` in User and `user_id`
  const strippedSource = stripModel(sourceMeaning, context.sourceModel)
  const strippedTarget = stripModel(targetMeaning, context.targetModel)
  if ((strippedSource !== sourceMeaning || strippedTarget !== targetMeaning) && sameSet(strippedSource, strippedTarget)) {
    const isKey = strippedSource.length === 1 && KEY_WORDS.has(strippedSource[0])
    return { score: isKey ? 0.9 : 0.75, reason: 'modelContext' }
  }

  if (weakSame(sourceMeaning, targetMeaning)) return { score: 0.74, reason: 'synonym' }

  const joinedSource = sourceMeaning.join('')
  const joinedTarget = targetMeaning.join('')
  // fuzzy ≥ 0.75 needs a Dice of at least 0.5: Jaro-Winkler, the costly part, is computed only then
  const words = dice(sourceMeaning, targetMeaning)
  const fuzzy = words >= 0.5 ? 0.5 * words + 0.5 * jaroWinkler(joinedSource, joinedTarget) : 0
  const contained = containment(sourceMeaning, targetMeaning)
  // Fuzzy similarity alone never reaches "high": a similar name is not the same name
  const fuzzyScore = fuzzy >= 0.75 ? fuzzy * 0.85 : 0
  const containedScore = contained >= 0.5 ? contained * 0.75 : 0
  if (fuzzyScore === 0 && containedScore === 0) return null
  return fuzzyScore >= containedScore
    ? { score: fuzzyScore, reason: 'similarName', similarity: Math.floor(fuzzy * 100) }
    : { score: containedScore, reason: 'containsName', similarity: Math.floor(contained * 100) }
}
