import { z } from 'zod'

const trimmed = z
  .string()
  .transform((value) => value.trim())
  .catch('')
const list = z.array(z.string().transform((value) => value.trim())).catch([])

const CharacterNoteSchema = z.object({
  name: z.string().transform((value) => value.trim()),
  aliases: list,
  traits: list,
  speech: trimmed,
  status: trimmed,
  arc: trimmed,
  quote: trimmed,
  evidence: trimmed,
})

const TermNoteSchema = z.object({
  name: z.string().transform((value) => value.trim()),
  aliases: list,
  description: trimmed,
  evidence: trimmed,
})

const HookNoteSchema = z.object({ text: z.string().transform((value) => value.trim()), evidence: trimmed })

/**
 * A number or grade worth keeping exact. `state` belongs to someone and moves with the
 * story, such as money or a rank. `anchor` belongs to the world, such as a price.
 */
const FactNoteSchema = z.object({
  kind: z.enum(['state', 'anchor']).catch('state'),
  owner: trimmed,
  name: z.string().transform((value) => value.trim()),
  value: z.string().transform((value) => value.trim()),
  /** Signed, such as -12铜. Empty when the prose simply states the value. */
  change: trimmed,
  /** Whether the prose states `value` outright, as opposed to it being worked out from `change`. */
  stated: z.boolean().catch(true),
  evidence: trimmed,
  /** The background worked this out to keep the world coherent. The prose never said it. */
  inferred: z.boolean().catch(false),
  /** Which known values an inferred fact follows from. */
  basis: trimmed,
})

const AmendmentNoteSchema = z.object({
  target: z.enum(['hook', 'character', 'term', 'fact']),
  ref: z.string().transform((value) => value.trim()),
  action: z.enum(['drop', 'amend']),
  field: trimmed,
  value: trimmed,
  reason: trimmed,
  evidence: trimmed,
})

const entries = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((items) => items.flatMap((item) => schema.safeParse(item).data ?? []) as z.output<T>[])

/** What the background model reports about one chapter. Malformed items are dropped one by one. */
const ArchivistReplySchema = z.object({
  summary: trimmed,
  /** The author rejected or rewrote this chapter in what followed, so none of it stands. */
  superseded: z.boolean().catch(false),
  inScene: list,
  characters: entries(CharacterNoteSchema),
  terms: entries(TermNoteSchema),
  hooksPlanted: entries(HookNoteSchema),
  hooksResolved: list,
  facts: entries(FactNoteSchema),
  amendments: entries(AmendmentNoteSchema),
})

export type ChapterNote = z.output<typeof ArchivistReplySchema>
export type CharacterNote = ChapterNote['characters'][number]
export type TermNote = ChapterNote['terms'][number]
export type HookNote = ChapterNote['hooksPlanted'][number]
export type FactNote = ChapterNote['facts'][number]

/**
 * A fact as a chapter record keeps it. `claimed` is what the prose said when it
 * disagreed with the ledger's own sum and the sum was kept, so the author can see it.
 */
export type SettledFactNote = FactNote & { claimed?: string }

/** Which side the author took where a chapter's prose and the ledger disagree. */
export type NovelResolution = 'ledger' | 'prose'

/**
 * The changes a chapter made to the numbers, read as soon as it was written, before
 * the author's replies settle it. It holds changes rather than balances, so it adds
 * onto whatever the settled ledger says and can be dropped without a trace. It only
 * counts while its chapter is on the path with the same text: regenerating, editing
 * or switching branches leaves it behind, and once the chapter settles its record
 * takes these over.
 */
export interface NovelPendingRecord {
  kind: 'pending'
  id: string
  messageId: string
  /** Fingerprint of the chapter text it was read from. */
  textHash: string
  facts: FactNote[]
  /** The author's choice per fact key, where the prose and the ledger disagree. */
  resolutions?: Record<string, NovelResolution>
  model: string
  createdAt: number
}

export const pendingRecordId = (messageId: string) => `pending:${messageId}`

/** A correction to an earlier record, addressed by the record's key. */
export interface NovelAmendment {
  target: 'hook' | 'character' | 'term' | 'fact'
  key: string
  action: 'drop' | 'amend'
  field: string
  value: string
  reason: string
}

/** One finished chapter. `covers` lists the path messages it accounts for: the reply that led to it and itself. */
export interface NovelChapterRecord {
  kind: 'chapter'
  id: string
  messageId: string
  covers: string[]
  /** `facts` is missing on chapters recorded before numbers were kept. */
  note: Omit<ChapterNote, 'hooksResolved' | 'amendments' | 'superseded' | 'facts'> & { facts?: SettledFactNote[] }
  /** Ids of earlier hooks this chapter paid off. */
  resolvedHookIds: string[]
  /** Corrections to earlier records that this chapter and what followed it called for. */
  amendments?: NovelAmendment[]
  model: string
  createdAt: number
}

/** A condensed stretch of chapters, so the story so far stays short in a very long session. */
export interface NovelRollupRecord {
  kind: 'rollup'
  id: string
  chapterIds: string[]
  summary: string
  model: string
  createdAt: number
}

export type NovelEditTarget = 'character' | 'term' | 'hook' | 'fact' | 'chapter' | 'rollup'

export interface NovelEditPatch {
  /** The whole text of a hook, a term's description, or a summary. */
  text?: string
  traits?: string[]
  speech?: string
  status?: string
}

/** The author's own change. It outranks everything the background records, then and later. */
export interface NovelEditRecord {
  kind: 'edit'
  id: string
  target: NovelEditTarget
  key: string
  action: 'update' | 'delete'
  patch?: NovelEditPatch
  /** How many chapters were recorded when the author made the change. */
  atChapter: number
  createdAt: number
}

/**
 * What the world pass worked out, attached to the chapter it had read up to, so
 * regenerating that chapter takes it back along with everything else.
 */
export interface NovelWorldRecord {
  kind: 'world'
  id: string
  chapterId: string
  facts: FactNote[]
  amendments: NovelAmendment[]
  model: string
  createdAt: number
}

export type NovelRecord =
  | NovelChapterRecord
  | NovelRollupRecord
  | NovelEditRecord
  | NovelWorldRecord
  | NovelPendingRecord

/** Read the model's reply as JSON, tolerating a code fence or text around the object. */
function readJsonObject(reply: string): unknown {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(reply.slice(start, end + 1))
  } catch {
    return null
  }
}

export function parseArchivistReply(reply: string): ChapterNote | null {
  const parsed = ArchivistReplySchema.safeParse(readJsonObject(reply))
  return parsed.success && (parsed.data.summary || parsed.data.superseded) ? parsed.data : null
}

/** The reply to a world pass, before its items are checked against the ledger. */
export function parseWorldReply(reply: string): Pick<ChapterNote, 'facts' | 'amendments'> | null {
  const raw = readJsonObject(reply)
  if (!raw || typeof raw !== 'object') return null
  return ArchivistReplySchema.pick({ facts: true, amendments: true }).parse(raw)
}

/** The reply to a pass that only collects numbers from an older chapter. */
export function parseFactsReply(reply: string): FactNote[] | null {
  const raw = readJsonObject(reply)
  if (!raw || !Array.isArray((raw as { facts?: unknown }).facts)) return null
  return ArchivistReplySchema.pick({ facts: true }).parse(raw).facts
}

function comparable(text: string): string {
  return text.normalize('NFKC').replace(/[\s"'“”‘’「」『』]/g, '')
}

/**
 * Keep only what the text supports: every note must carry a quote found verbatim in
 * the chapter or in what followed it. A cheap model can then write to memory
 * unreviewed, since it cannot add a fact it did not read. This also keeps out what
 * only the options at the end of a chapter proposed, when the caller passes the
 * text without them.
 */
export function keepEvidenced(note: ChapterNote, sourceText: string): ChapterNote {
  const chapter = comparable(sourceText)
  const inChapter = (quote: string) => {
    const wanted = comparable(quote)
    return wanted.length > 0 && chapter.includes(wanted)
  }
  return {
    ...note,
    characters: note.characters
      .filter((item) => item.name && inChapter(item.evidence))
      .map((item) => ({ ...item, quote: inChapter(item.quote) ? item.quote : '' })),
    terms: note.terms.filter((item) => item.name && inChapter(item.evidence)),
    hooksPlanted: note.hooksPlanted.filter((item) => item.text && inChapter(item.evidence)),
    facts: note.facts.filter((item) => item.name && item.value && !item.inferred && inChapter(item.evidence)),
    amendments: note.amendments.filter(
      (item) => item.ref && (item.action === 'drop' || item.value) && inChapter(item.evidence)
    ),
  }
}

const OPTION_LABEL = '(?:[A-Da-d①②③④]|[1-4]|选项\\s*[A-Da-d1-4一二三四]|[一二三四])'
// Models often dress these lines as list items or in bold: "- **A.** 去钟楼".
const OPTION_PREFIX = new RegExp(`^\\s*(?:[-*+>]\\s+)?\\**\\s*${OPTION_LABEL}\\s*\\**\\s*[.．、:：)）]\\s*\\**\\s*`)
const isOptionLine = (line: string) => {
  const prefix = OPTION_PREFIX.exec(line)
  return prefix !== null && line.length > prefix[0].length
}

/** Where a chapter's trailing block of two or more options starts, or -1. */
function findTrailingOptions(lines: readonly string[]): number {
  let start = lines.length
  let options = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (isOptionLine(line)) {
      options++
      start = index
    } else if (line.trim() && options > 0) {
      break
    } else if (line.trim()) {
      return -1
    }
  }
  return options >= 2 ? start : -1
}

/**
 * Cut the options a chapter ends with, so a choice the author did not take cannot
 * count as something that happened. Only a trailing block of two or more option
 * lines is removed; a chapter without one comes back whole.
 */
export function stripTrailingOptions(chapterText: string): string {
  const lines = chapterText.trimEnd().split('\n')
  let end = findTrailingOptions(lines)
  if (end < 0) return chapterText
  // A heading such as "接下来：" right above the options belongs to them.
  const before = lines[end - 1]?.trim() ?? ''
  if (before.length > 0 && before.length <= 20 && /[:：?？]$/.test(before)) end--
  return lines.slice(0, end).join('\n').trimEnd()
}

/** The options a chapter ends with, without their labels. */
export function extractTrailingOptions(chapterText: string): string[] {
  const lines = chapterText.trimEnd().split('\n')
  const start = findTrailingOptions(lines)
  if (start < 0) return []
  return lines
    .slice(start)
    .filter(isOptionLine)
    .map((line) => line.replace(OPTION_PREFIX, '').replaceAll('**', '').trim())
}
