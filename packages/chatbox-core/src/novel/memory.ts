import type {
  NovelAmendment,
  NovelChapterRecord,
  NovelEditRecord,
  NovelEditTarget,
  NovelRecord,
  NovelRollupRecord,
  SettledFactNote,
} from './chapter-record'
import type { NovelContextSnapshot } from './context-source'
import { foldNovelLedger, type NovelLedger, renderLedgerLines } from './ledger'
import type { LoreEntry, StorySegment } from './types'

const MAX_TRAITS = 8
const MAX_QUOTES = 3
const MAX_ARC_NOTES = 3
const MAX_CHANGES = 20
const CHARACTER_PRIORITY = 10
const TERM_PRIORITY = 5

export interface NovelCharacter {
  name: string
  aliases: string[]
  traits: string[]
  speech: string
  status: string
  arc: string[]
  quotes: string[]
}

export interface NovelTerm {
  name: string
  aliases: string[]
  description: string
}

export interface NovelHook {
  id: string
  text: string
  quote: string
  chapter: number
}

/** One line of the story so far, and what an edit of it should address. */
export interface NovelStoryEntry extends StorySegment {
  target: 'chapter' | 'rollup'
  key: string
  summary: string
}

/** Something the author deleted. It stays out of memory until restored. */
export interface NovelDeletedItem {
  target: NovelEditTarget
  key: string
  label: string
}

/** A number or grade the story must keep exact. */
export interface NovelFact {
  key: string
  kind: 'state' | 'anchor'
  /** Who it belongs to. Empty for the world's reference values. */
  owner: string
  name: string
  value: string
  change: string
  chapter: number
  /** The background worked this out, so anything the prose says replaces it. */
  inferred: boolean
  basis: string
}

/** A correction the background made to an earlier record. */
export interface NovelChange {
  chapter: number
  label: string
  action: 'drop' | 'amend'
  value: string
  reason: string
}

/** Everything the records say about the story along one message path. */
export interface NovelMemory {
  chapters: NovelChapterRecord[]
  /** The newest message such that it and everything before it on the path is accounted for. */
  coveredThroughMessageId?: string
  segments: NovelStoryEntry[]
  characters: NovelCharacter[]
  terms: NovelTerm[]
  openHooks: NovelHook[]
  facts: NovelFact[]
  /** Chapters recorded before numbers were kept, which a scan can still read. */
  unscannedChapters: number
  /** The chapter the last world pass had read up to, or 0. */
  worldChapter: number
  inScene: string[]
  deleted: NovelDeletedItem[]
  /** Newest first. */
  changes: NovelChange[]
}

/** A fact keeps its identity by owner and name, so each new value replaces the last. */
export function factKey(kind: NovelFact['kind'], owner: string, name: string): string {
  return kind === 'anchor' ? `world/${name}` : `${owner}/${name}`
}

/** Split a list of traits as it is written by hand or by the background. */
export function splitTraits(text: string): string[] {
  return text
    .split(/[、,，\s]+/)
    .map((trait) => trait.trim())
    .filter(Boolean)
}

function uniquePush(target: string[], values: readonly string[], limit = Number.POSITIVE_INFINITY): void {
  for (const value of values) {
    if (value && !target.includes(value) && target.length < limit) target.push(value)
  }
}

/** Chapter records that apply to this path, oldest first, stopping at the first gap. */
function selectChapters(records: readonly NovelRecord[], pathMessageIds: readonly string[]) {
  const onPath = new Set(pathMessageIds)
  const owners = new Map<string, NovelChapterRecord>()
  for (const record of records) {
    if (record.kind !== 'chapter' || !onPath.has(record.messageId)) continue
    for (const id of record.covers) owners.set(id, record)
  }
  const chapters: NovelChapterRecord[] = []
  let coveredThroughMessageId: string | undefined
  for (const id of pathMessageIds) {
    const owner = owners.get(id)
    if (!owner) break
    coveredThroughMessageId = id
    if (owner.messageId === id) chapters.push(owner)
  }
  return { chapters, coveredThroughMessageId }
}

const editKey = (target: NovelEditTarget, key: string) => `${target}:${key}`

function collectEdits(records: readonly NovelRecord[]): Map<string, NovelEditRecord> {
  const edits = new Map<string, NovelEditRecord>()
  for (const record of records) {
    if (record.kind === 'edit') edits.set(editKey(record.target, record.key), record)
  }
  return edits
}

/** A paragraph stops being current once the author edits a chapter it was condensed from. */
export function isRollupCurrent(rollup: NovelRollupRecord, records: readonly NovelRecord[]): boolean {
  const covered = new Set(rollup.chapterIds)
  return !records.some(
    (record) =>
      record.kind === 'edit' &&
      record.target === 'chapter' &&
      covered.has(record.key) &&
      record.createdAt > rollup.createdAt
  )
}

/** A chapter as the author left it. The summary is what everything built on the chapter reads. */
function withAuthoredSummary(chapter: NovelChapterRecord, edits: ReadonlyMap<string, NovelEditRecord>) {
  const edit = edits.get(editKey('chapter', chapter.id))
  if (!edit) return chapter
  const summary = edit.action === 'delete' ? '' : (edit.patch?.text ?? chapter.note.summary)
  return { ...chapter, note: { ...chapter.note, summary } }
}

function buildSegments(
  chapters: readonly NovelChapterRecord[],
  records: readonly NovelRecord[],
  edits: ReadonlyMap<string, NovelEditRecord>
): NovelStoryEntry[] {
  const rollups = new Map<string, NovelRollupRecord>()
  for (const record of records) {
    if (record.kind === 'rollup' && record.chapterIds[0] && isRollupCurrent(record, records)) {
      rollups.set(record.chapterIds[0], record)
    }
  }
  const segments: NovelStoryEntry[] = []
  for (let index = 0; index < chapters.length; index++) {
    const rollup = rollups.get(chapters[index].id)
    const applies = rollup?.chapterIds.every((id, offset) => chapters[index + offset]?.id === id)
    if (rollup && applies) {
      const last = index + rollup.chapterIds.length - 1
      // A paragraph written after the author's edit is built on it, so it replaces the edit.
      const edit = edits.get(editKey('rollup', rollup.id))
      const current = edit && edit.createdAt >= rollup.createdAt ? edit : undefined
      const summary = current?.action === 'delete' ? '' : (current?.patch?.text ?? rollup.summary)
      if (summary) {
        segments.push({
          target: 'rollup',
          key: rollup.id,
          summary,
          throughTurnId: chapters[last].messageId,
          text: `第${index + 1}至${last + 1}章：${summary}`,
        })
      }
      index = last
      continue
    }
    const { summary } = chapters[index].note
    if (summary) {
      segments.push({
        target: 'chapter',
        key: chapters[index].id,
        summary,
        throughTurnId: chapters[index].messageId,
        text: `第${index + 1}章：${summary}`,
      })
    }
  }
  return segments
}

/**
 * Derive the story's memory from its records. Only records on the given path count,
 * so regenerating a chapter or switching a branch rewinds the memory by itself. The
 * background's own corrections apply in chapter order; the author's edits apply last,
 * so nothing the background writes can overrule them.
 */
export function foldNovelMemory(records: readonly NovelRecord[], pathMessageIds: readonly string[]): NovelMemory {
  const selected = selectChapters(records, pathMessageIds)
  const { coveredThroughMessageId } = selected
  const edits = collectEdits(records)
  const chapters = selected.chapters.map((chapter) => withAuthoredSummary(chapter, edits))
  const removedByAuthor = (target: NovelEditTarget, key: string) => edits.get(editKey(target, key))?.action === 'delete'

  const characters = new Map<string, NovelCharacter>()
  const nameOf = new Map<string, string>()
  const statusChapter = new Map<string, number>()
  const terms = new Map<string, NovelTerm>()
  const hooks = new Map<string, NovelHook>()
  const facts = new Map<string, NovelFact>()
  const changes: NovelChange[] = []

  const amend = (item: NovelAmendment, chapter: number) => {
    const key = item.target === 'character' ? (nameOf.get(item.key) ?? item.key) : item.key
    // What the author has touched is theirs: the background leaves it alone.
    if (edits.has(editKey(item.target, key))) return
    let label = key
    if (item.target === 'hook') {
      const hook = hooks.get(key)
      if (!hook) return
      label = hook.text
      if (item.action === 'drop') hooks.delete(key)
      else hook.text = item.value
    } else if (item.target === 'fact') {
      const fact = facts.get(key)
      if (!fact) return
      label = fact.owner ? `${fact.owner} ${fact.name}` : fact.name
      if (item.action === 'drop') facts.delete(key)
      else Object.assign(fact, { value: item.value, change: '', chapter })
    } else if (item.target === 'term') {
      const term = terms.get(key)
      if (!term) return
      if (item.action === 'drop') terms.delete(key)
      else term.description = item.value
    } else {
      const character = characters.get(key)
      if (!character) return
      if (item.action === 'drop') {
        characters.delete(key)
      } else if (item.field === 'traits') {
        character.traits = splitTraits(item.value).slice(0, MAX_TRAITS)
      } else if (item.field === 'speech') {
        character.speech = item.value
      } else if (item.field === 'status') {
        character.status = item.value
        statusChapter.set(key, chapter)
      } else {
        return
      }
    }
    changes.unshift({ chapter, label, action: item.action, value: item.value, reason: item.reason })
  }

  const applyFact = (note: SettledFactNote, number: number) => {
    const owner = note.kind === 'anchor' ? '' : (nameOf.get(note.owner) ?? note.owner)
    const key = factKey(note.kind, owner, note.name)
    if (removedByAuthor('fact', key)) return
    // The prose and the author outrank what the background worked out.
    const known = facts.get(key)
    if (note.inferred && known && (edits.has(editKey('fact', key)) || !known.inferred)) return
    if (note.claimed) {
      changes.unshift({
        chapter: number,
        label: owner ? `${owner} ${note.name}` : note.name,
        action: 'amend',
        value: note.value,
        reason: `正文写作${note.claimed}，按${known?.value ?? ''}${note.change}应为${note.value}`,
      })
    }
    facts.set(key, {
      key,
      kind: note.kind,
      owner,
      name: note.name,
      value: note.value,
      change: note.change,
      chapter: number,
      inferred: note.inferred ?? false,
      basis: note.basis ?? '',
    })
  }

  const worlds = new Map(
    records.flatMap((record) => (record.kind === 'world' ? [[record.chapterId, record] as const] : []))
  )
  let worldChapter = 0

  chapters.forEach((chapter, index) => {
    const number = index + 1
    for (const note of chapter.note.characters) {
      const name = nameOf.get(note.name) ?? note.name
      if (removedByAuthor('character', name)) {
        for (const alias of note.aliases) nameOf.set(alias, name)
        continue
      }
      const character = characters.get(name) ?? {
        name,
        aliases: [],
        traits: [],
        speech: '',
        status: '',
        arc: [],
        quotes: [],
      }
      uniquePush(
        character.aliases,
        note.aliases.filter((alias) => alias !== name)
      )
      uniquePush(character.traits, note.traits, MAX_TRAITS)
      character.speech = note.speech || character.speech
      if (note.status) {
        character.status = note.status
        statusChapter.set(name, number)
      }
      if (note.arc && character.arc.at(-1) !== note.arc)
        character.arc = [...character.arc, note.arc].slice(-MAX_ARC_NOTES)
      if (note.quote && !character.quotes.includes(note.quote)) {
        character.quotes = [...character.quotes, note.quote].slice(-MAX_QUOTES)
      }
      characters.set(name, character)
      nameOf.set(name, name)
      for (const alias of character.aliases) nameOf.set(alias, name)
    }
    for (const note of chapter.note.terms) {
      if (removedByAuthor('term', note.name)) continue
      const term = terms.get(note.name)
      terms.set(note.name, {
        name: note.name,
        aliases: [...new Set([...(term?.aliases ?? []), ...note.aliases])],
        description: note.description || term?.description || '',
      })
    }
    chapter.note.hooksPlanted.forEach((note, hookIndex) => {
      const id = `${chapter.messageId}:${hookIndex}`
      hooks.set(id, { id, text: note.text, quote: note.evidence, chapter: number })
    })
    for (const id of chapter.resolvedHookIds) hooks.delete(id)
    for (const note of chapter.note.facts ?? []) applyFact(note, number)
    for (const item of chapter.amendments ?? []) amend(item, number)
    const world = worlds.get(chapter.id)
    if (world) {
      worldChapter = number
      for (const note of world.facts) applyFact(note, number)
      for (const item of world.amendments) amend(item, number)
    }
  })

  const deleted: NovelDeletedItem[] = []
  for (const edit of edits.values()) {
    if (edit.target === 'fact') {
      if (edit.action === 'delete') {
        deleted.push({ target: edit.target, key: edit.key, label: edit.key.replace(/^world\//, '') })
        continue
      }
      const fact = facts.get(edit.key)
      // A held amount moves on with the story; a reference value is the author's for good.
      if (fact && edit.patch?.text !== undefined && (fact.kind === 'anchor' || edit.atChapter >= fact.chapter)) {
        fact.value = edit.patch.text
        fact.change = ''
        fact.inferred = false
      }
    } else if (edit.target === 'character') {
      if (edit.action === 'delete') {
        characters.delete(edit.key)
        deleted.push({ target: edit.target, key: edit.key, label: edit.key })
        continue
      }
      const character = characters.get(edit.key)
      if (!character) continue
      if (edit.patch?.traits) character.traits = edit.patch.traits
      if (edit.patch?.speech !== undefined) character.speech = edit.patch.speech
      // A state moves on with the story: the author's value holds until a later chapter changes it.
      if (edit.patch?.status !== undefined && edit.atChapter >= (statusChapter.get(edit.key) ?? 0)) {
        character.status = edit.patch.status
      }
    } else if (edit.target === 'term') {
      if (edit.action === 'delete') {
        terms.delete(edit.key)
        deleted.push({ target: edit.target, key: edit.key, label: edit.key })
        continue
      }
      const term = terms.get(edit.key)
      if (term && edit.patch?.text !== undefined) term.description = edit.patch.text
    } else if (edit.target === 'hook') {
      const hook = hooks.get(edit.key)
      if (!hook) continue
      if (edit.action === 'delete') {
        hooks.delete(edit.key)
        deleted.push({ target: edit.target, key: edit.key, label: hook.text })
      } else if (edit.patch?.text !== undefined) {
        hook.text = edit.patch.text
      }
    } else if (edit.action === 'delete') {
      const firstChapter = edit.target === 'chapter' ? edit.key : edit.key.replace(/^rollup:/, '')
      const index = chapters.findIndex((chapter) => chapter.id === firstChapter)
      if (index < 0) continue
      const label = edit.target === 'chapter' ? `第${index + 1}章的概要` : `第${index + 1}章起的阶段总结`
      deleted.push({ target: edit.target, key: edit.key, label })
    }
  }

  return {
    chapters,
    coveredThroughMessageId,
    segments: buildSegments(chapters, records, edits),
    characters: [...characters.values()],
    terms: [...terms.values()],
    openHooks: [...hooks.values()],
    inScene: (chapters.findLast((chapter) => chapter.note.inScene.length > 0)?.note.inScene ?? [])
      .map((name) => nameOf.get(name) ?? name)
      .filter((name) => !removedByAuthor('character', name)),
    facts: [...facts.values()],
    unscannedChapters: chapters.filter((chapter) => chapter.note.facts === undefined).length,
    worldChapter,
    deleted,
    changes: changes.slice(0, MAX_CHANGES),
  }
}

function characterContent(character: NovelCharacter): string {
  const lines = [
    character.traits.length > 0 ? `性格：${character.traits.join('、')}` : '',
    character.speech ? `说话方式：${character.speech}` : '',
    character.status ? `当前状态：${character.status}` : '',
    character.arc.length > 0 ? `人物弧光：${character.arc.join(' → ')}` : '',
    character.quotes.length > 0 ? `原文台词：${character.quotes.map((quote) => `「${quote}」`).join(' ')}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

const characterId = (name: string) => `character:${name}`

/**
 * Turn the memory into what one request needs. Characters seen in the latest settled
 * chapter stay active even when the text only says 她 or 师父, through the sticky
 * mechanism. Open foreshadowing brings its original sentence along, oldest first,
 * because the oldest is the most likely to be forgotten.
 *
 * `ledger` is the numbers with the newest chapters' changes added on. Without it the
 * writer gets the settled numbers and is told where they stop.
 */
export function buildNovelSnapshot(
  memory: NovelMemory,
  ledger: NovelLedger = foldNovelLedger(memory, [], [])
): NovelContextSnapshot {
  const lore: LoreEntry[] = [
    ...memory.characters.map((character) => ({
      id: characterId(character.name),
      name: character.name,
      keys: [character.name, ...character.aliases],
      content: characterContent(character),
      priority: CHARACTER_PRIORITY,
    })),
    ...memory.terms.map((term) => ({
      id: `term:${term.name}`,
      name: term.name,
      keys: [term.name, ...term.aliases],
      content: term.description,
      priority: TERM_PRIORITY,
    })),
  ]
  return {
    lore: lore.filter((entry) => entry.content),
    storySegments: memory.segments,
    coveredThroughMessageId: memory.coveredThroughMessageId,
    // The ledger leads, so a tight budget cuts foreshadowing before it cuts a number.
    stateLines: [
      ...renderLedgerLines(ledger),
      // Recorded a little behind the story, so it says "recently", not "now".
      ...(memory.inScene.length > 0 ? [`近期在场：${memory.inScene.join('、')}`] : []),
      ...memory.openHooks.map((hook) => `未回收的伏笔（第${hook.chapter}章）：${hook.text}。原文：「${hook.quote}」`),
    ],
    stickyRemaining: Object.fromEntries(memory.inScene.map((name) => [characterId(name), 1])),
  }
}
