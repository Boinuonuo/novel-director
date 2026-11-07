import { applyChange, collectExchangeRates, type ExchangeRates, sameAmount } from './amounts'
import type {
  FactNote,
  NovelEditRecord,
  NovelPendingRecord,
  NovelRecord,
  NovelResolution,
  SettledFactNote,
} from './chapter-record'
import { factKey, type NovelFact, type NovelMemory } from './memory'

/** Where the prose and the ledger part ways. */
export type NovelConflictKind =
  /** The prose gives both a change and a balance, and they do not add up. */
  | 'sum'
  /** The prose states a new amount with no change to explain it. */
  | 'jump'
  /** A reference value differs from the one the world already has. */
  | 'anchor'

export interface Reconciled {
  value: string
  conflict?: { kind: NovelConflictKind; expected: string; claimed: string }
}

export type ReconcileStage = 'pending' | 'settled'

/**
 * What a chapter's reported fact comes to, given what the ledger held before it.
 *
 * A balance that does not match its own change is an arithmetic slip, so the sum
 * stands unless the author takes the prose. An amount that simply jumps may be
 * deliberate, so the prose stands unless the author takes the ledger. A new
 * reference value waits while the chapter is pending; once the author's replies
 * have settled the chapter it replaces the old one, unless they kept the old one.
 */
export function reconcileFact(
  previous: string | undefined,
  note: Pick<FactNote, 'kind' | 'value' | 'change' | 'stated'>,
  rates: ExchangeRates,
  stage: ReconcileStage,
  resolution?: NovelResolution
): Reconciled {
  if (note.kind === 'anchor') {
    if (previous === undefined || previous === note.value || sameAmount(previous, note.value, rates)) {
      return { value: note.value }
    }
    const chosen = resolution ?? (stage === 'pending' ? 'ledger' : 'prose')
    return {
      value: chosen === 'ledger' ? previous : note.value,
      conflict: { kind: 'anchor', expected: previous, claimed: note.value },
    }
  }
  if (note.change) {
    const computed = applyChange(previous, note.change, rates)
    if (computed === null) return { value: note.value }
    // The model's own arithmetic is not the prose: it is simply corrected.
    if (!note.stated) return { value: computed }
    if (sameAmount(note.value, computed, rates) !== false) return { value: note.value }
    return {
      value: resolution === 'prose' ? note.value : computed,
      conflict: { kind: 'sum', expected: computed, claimed: note.value },
    }
  }
  if (note.stated && previous !== undefined && sameAmount(note.value, previous, rates) === false) {
    return {
      value: resolution === 'ledger' ? previous : note.value,
      conflict: { kind: 'jump', expected: previous, claimed: note.value },
    }
  }
  return { value: note.value }
}

export const defaultResolution = (kind: NovelConflictKind): NovelResolution => (kind === 'jump' ? 'prose' : 'ledger')

/**
 * Check a settled chapter's facts against the ledger before it, including earlier
 * notes of the same chapter. A slip in the prose is kept as `claimed`, so the
 * author can still see what the chapter said.
 */
export function settleFactNotes(
  notes: readonly FactNote[],
  memory: Pick<NovelMemory, 'facts' | 'characters'>,
  resolutions: Readonly<Record<string, NovelResolution>> = {}
): SettledFactNote[] {
  const latest = new Map(memory.facts.map((fact) => [fact.key, fact.inferred ? undefined : fact.value]))
  const nameOf = aliasMap(memory)
  const rates = collectExchangeRates([
    ...notes.filter((note) => note.kind === 'anchor').map((note) => note.value),
    ...memory.facts.filter((fact) => fact.kind === 'anchor').map((fact) => fact.value),
  ])
  return notes.map((note) => {
    const key = noteKey(note, nameOf)
    const result = reconcileFact(latest.get(key), note, rates, 'settled', resolutions[key])
    latest.set(key, result.value)
    const { claimed: _claimed, ...rest } = note as SettledFactNote
    const keptLedger = result.conflict && result.value !== note.value && result.conflict.kind === 'sum'
    return keptLedger ? { ...rest, value: result.value, claimed: note.value } : { ...rest, value: result.value }
  })
}

function aliasMap(memory: Pick<NovelMemory, 'characters'>): Map<string, string> {
  return new Map(
    memory.characters.flatMap((character) =>
      [character.name, ...character.aliases].map((name) => [name, character.name] as const)
    )
  )
}

function noteKey(note: Pick<FactNote, 'kind' | 'owner' | 'name'>, nameOf: ReadonlyMap<string, string>): string {
  return factKey(note.kind, note.kind === 'anchor' ? '' : (nameOf.get(note.owner) ?? note.owner), note.name)
}

/** The ledger key a reported fact files under, whatever alias named its owner. */
export function factNoteKey(
  note: Pick<FactNote, 'kind' | 'owner' | 'name'>,
  memory: Pick<NovelMemory, 'characters'>
): string {
  return noteKey(note, aliasMap(memory))
}

/** A chapter after the settled ones, as the path holds it now. */
export interface UnsettledChapter {
  messageId: string
  textHash: string
}

/** One step a fact took in a chapter that has not settled. */
export interface NovelPendingStep {
  chapter: number
  change: string
  value: string
}

/** A number as the writer should use it now: settled, then moved by the newest chapters. */
export interface NovelLedgerFact extends NovelFact {
  /** The settled value, when newer chapters moved it. */
  settled?: { value: string; chapter: number }
  /** Changes from chapters not yet settled, oldest first. Empty when the value is settled. */
  pending: NovelPendingStep[]
}

export interface NovelConflict {
  kind: NovelConflictKind
  chapter: number
  messageId: string
  key: string
  owner: string
  name: string
  /** What the ledger says it should be. */
  expected: string
  /** What the prose says. */
  claimed: string
  /** The value before the chapter, and the change the prose gave, for a sum. */
  previous?: string
  change?: string
  chosen: NovelResolution
  /** Whether the author made the choice, as opposed to it being the default. */
  resolved: boolean
}

export interface NovelLedger {
  /** Chapters the settled records account for. */
  settledThrough: number
  /** The newest chapter whose changes are counted. */
  through: number
  facts: NovelLedgerFact[]
  conflicts: NovelConflict[]
  /** The first chapter after the settled ones that has not been read yet. From there the prose is the only account. */
  missingFrom?: number
}

/** A short fingerprint of a chapter's text, so a record made from other text is never used. */
export function chapterFingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`
}

/**
 * The ledger as the writer should see it now: the settled values, with the changes of
 * each newer chapter added on in order. A chapter's changes count only while its text
 * is the one they were read from, and only up to the first chapter not read yet, so
 * a sum never skips a step. The author's edits apply last, as in the settled memory.
 */
export function foldNovelLedger(
  memory: NovelMemory,
  records: readonly NovelRecord[],
  unsettled: readonly UnsettledChapter[]
): NovelLedger {
  const pending = new Map(
    records.flatMap((record) => (record.kind === 'pending' ? [[record.messageId, record] as const] : []))
  )
  const edits = new Map(
    records.flatMap((record) =>
      record.kind === 'edit' && record.target === 'fact' ? [[record.key, record] as const] : []
    )
  )
  const nameOf = aliasMap(memory)
  const facts = new Map<string, NovelLedgerFact>(memory.facts.map((fact) => [fact.key, { ...fact, pending: [] }]))
  const conflicts: NovelConflict[] = []
  const settledThrough = memory.chapters.length
  let through = settledThrough
  let missingFrom: number | undefined

  for (const [index, chapter] of unsettled.entries()) {
    const number = settledThrough + index + 1
    const record: NovelPendingRecord | undefined = pending.get(chapter.messageId)
    if (!record || record.textHash !== chapter.textHash) {
      missingFrom = number
      break
    }
    through = number
    // A rate this chapter states works for its own sums, but never over one the world already has.
    const rates = collectExchangeRates([
      ...record.facts.filter((note) => note.kind === 'anchor').map((note) => note.value),
      ...[...facts.values()].filter((fact) => fact.kind === 'anchor').map((fact) => fact.value),
    ])
    for (const note of record.facts) {
      const key = noteKey(note, nameOf)
      if (edits.get(key)?.action === 'delete') continue
      const known = facts.get(key)
      const resolution = record.resolutions?.[key]
      const previous = known && !known.inferred ? known.value : undefined
      const result = reconcileFact(previous, note, rates, 'pending', resolution)
      if (result.conflict) {
        conflicts.push({
          ...result.conflict,
          chapter: number,
          messageId: chapter.messageId,
          key,
          owner: note.kind === 'anchor' ? '' : (nameOf.get(note.owner) ?? note.owner),
          name: note.name,
          ...(result.conflict.kind === 'sum' ? { previous, change: note.change } : {}),
          chosen: resolution ?? defaultResolution(result.conflict.kind),
          resolved: resolution !== undefined,
        })
      }
      if (known && result.value === known.value) continue
      facts.set(key, {
        key,
        kind: note.kind,
        owner: note.kind === 'anchor' ? '' : (nameOf.get(note.owner) ?? note.owner),
        name: known?.name ?? note.name,
        value: result.value,
        change: note.change,
        chapter: number,
        inferred: false,
        basis: '',
        settled: known && known.pending.length === 0 ? { value: known.value, chapter: known.chapter } : known?.settled,
        pending: [...(known?.pending ?? []), { chapter: number, change: note.change, value: result.value }],
      })
    }
  }

  // What the author set after reading a chapter stands over that chapter's changes.
  for (const fact of facts.values()) {
    const edit: NovelEditRecord | undefined = edits.get(fact.key)
    const text = edit?.action === 'update' ? edit.patch?.text : undefined
    if (text === undefined || fact.pending.length === 0 || edit === undefined || edit.atChapter < fact.chapter) continue
    fact.value = text
    fact.pending = []
    fact.settled = undefined
  }
  const authored = (conflict: NovelConflict) => {
    const edit = edits.get(conflict.key)
    return edit !== undefined && edit.atChapter >= conflict.chapter
  }

  return {
    settledThrough,
    through,
    facts: [...facts.values()],
    conflicts: conflicts.filter((conflict) => !authored(conflict)),
    ...(missingFrom !== undefined ? { missingFrom } : {}),
  }
}

const ownerLabel = (owner: string) => owner || '主角'

function provenance(fact: NovelLedgerFact): string {
  if (fact.pending.length === 0) return ''
  const steps = [
    ...(fact.settled ? [`第${fact.settled.chapter}章 ${fact.settled.value}`] : []),
    ...fact.pending.map((step) => `第${step.chapter}章 ${step.change || step.value}`),
  ]
  return `（${steps.join(' → ')}）`
}

function ledgerHeader(ledger: NovelLedger): string {
  const { settledThrough: settled, through, missingFrom } = ledger
  const parts: string[] = []
  if (through > settled) {
    const span = through > settled + 1 ? `第${settled + 1}至${through}章` : `第${through}章`
    parts.push(
      settled > 0
        ? `以下数值已确认到第${settled}章，${span}刚写下的变化也已算进去，待作者确认。`
        : `以下数值来自${span}，刚写下，待作者确认。`,
      '写到这些数值时必须相符；括号里是来历，不要重复计算。'
    )
  } else {
    parts.push(`以下数值记到第${settled}章。`)
  }
  if (missingFrom !== undefined) {
    parts.push(`第${missingFrom}章起的增减还没记入，从那里起以正文为准继续累计。`)
  } else if (through <= settled) {
    parts.push('之后章节里的增减以正文为准继续累计，写到这些数值时必须相符。')
  }
  parts.push('标"推定"的是为保持世界自洽补全的，不必特意写出，但不要与之矛盾。')
  return parts.join('')
}

/** A slip the next chapter must not carry on: only where the ledger's value was kept over the prose. */
function conflictLine(conflict: NovelConflict): string {
  const what = conflict.kind === 'anchor' ? conflict.name : `${ownerLabel(conflict.owner)}的${conflict.name}`
  if (conflict.kind === 'sum') {
    return `第${conflict.chapter}章正文写${what}是${conflict.claimed}，但${conflict.previous ?? ''}${conflict.change ?? ''}应为${conflict.expected}。续写按${conflict.expected}算，不要沿用${conflict.claimed}。`
  }
  if (conflict.kind === 'jump') {
    return `第${conflict.chapter}章正文把${what}写成了${conflict.claimed}，作者确认应为${conflict.expected}。续写按${conflict.expected}算。`
  }
  return `第${conflict.chapter}章写到${what}＝${conflict.claimed}，与已有的${conflict.expected}不符，仍以${conflict.expected}为准。`
}

/**
 * The numbers as lines for the writer: slips to avoid first, then held amounts by
 * owner, then the world's reference values. They come before anything else in the
 * per-turn block, so a tight budget cuts foreshadowing before it cuts the ledger.
 */
export function renderLedgerLines(ledger: NovelLedger): string[] {
  if (ledger.facts.length === 0) return []
  const movedIn = new Map(ledger.facts.map((fact) => [fact.key, fact.chapter]))
  // Only the newest word on a number matters: a later chapter that moved it again has moved on.
  const current = (conflict: NovelConflict) =>
    (movedIn.get(conflict.key) ?? 0) <= conflict.chapter &&
    !ledger.conflicts.some((other) => other.key === conflict.key && other.chapter > conflict.chapter)
  const slips = ledger.conflicts
    .filter((conflict) => conflict.chosen === 'ledger' && current(conflict))
    .map(conflictLine)

  const held = ledger.facts.filter((fact) => fact.kind === 'state')
  const owners = [...new Set(held.map((fact) => fact.owner))]
  const heldLines = owners.map((owner) => {
    const entries = held
      .filter((fact) => fact.owner === owner)
      .map((fact) => `${fact.name} ${fact.value}${fact.inferred ? '（推定）' : provenance(fact)}`)
    return `${ownerLabel(owner)}：${entries.join('；')}`
  })
  const anchors = ledger.facts.filter((fact) => fact.kind === 'anchor')
  const anchorLine = (fact: NovelLedgerFact) =>
    fact.inferred
      ? `世界推定：${fact.name}＝${fact.value}`
      : fact.pending.length > 0
        ? `世界基准（第${fact.chapter}章，待确认）：${fact.name}＝${fact.value}`
        : `世界基准：${fact.name}＝${fact.value}`
  return [
    ...slips,
    ledgerHeader(ledger),
    ...heldLines,
    ...anchors.filter((fact) => !fact.inferred).map(anchorLine),
    ...anchors.filter((fact) => fact.inferred).map(anchorLine),
  ]
}
