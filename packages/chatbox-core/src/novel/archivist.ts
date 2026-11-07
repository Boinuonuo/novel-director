import { getMessageText } from '@shared/utils/message'
import type { Message } from '../types'
import {
  type ChapterNote,
  type FactNote,
  keepEvidenced,
  type NovelAmendment,
  type NovelChapterRecord,
  type NovelPendingRecord,
  type NovelRecord,
  type NovelRollupRecord,
  type NovelWorldRecord,
  parseArchivistReply,
  parseFactsReply,
  parseWorldReply,
  pendingRecordId,
  stripTrailingOptions,
} from './chapter-record'
import {
  chapterFingerprint,
  factNoteKey,
  foldNovelLedger,
  type NovelLedger,
  settleFactNotes,
  type UnsettledChapter,
} from './ledger'
import { foldNovelMemory, isRollupCurrent, type NovelMemory } from './memory'

const READ_BATCH = 40
const SETTLE_DELAY_MS = 2_000
/**
 * A chapter is recorded only after this many later replies. AI writes the chapter but
 * the author decides what stands, and their next replies show what they took up,
 * changed or ignored. The newest prose is still in the request verbatim meanwhile.
 */
const SETTLE_REPLIES = 2
/** A stretch this long is condensed into one paragraph once enough newer chapters follow it. */
const ROLLUP_CHAPTERS = 10
const MAX_KNOWN_NAMES = 60
const MAX_WORLD_STORY_LINES = 30
/** However quiet the story, the world's numbers are checked against each other this often. */
const WORLD_MAX_GAP = 10
/** New numbers wait for this many chapters, so the pass sees a few of them together. */
const WORLD_MIN_GAP = 3
/** The prompt asks for a handful. This stops a model that gets carried away. */
const MAX_INFERRED_PER_PASS = 8
/**
 * The newest chapters' numbers are read as soon as they are written, but only while
 * the settled records are close behind. Further back, the background is catching up
 * and its own records come first; a sum must never skip the chapters in between.
 */
const MAX_PENDING_CHAPTERS = 4
const MAX_UNSETTLED_MESSAGES = 24

export type NovelArchivistState = 'idle' | 'running' | 'failed'

export interface NovelArchivistStatus {
  state: NovelArchivistState
  chapters: number
  /** What the running pass is doing, when it is not recording a chapter. */
  task?: 'world'
  error?: string
}

export interface NovelArchivistPorts {
  /** Whether this session has long-form support on and a background model is set. */
  isEnabled(sessionId: string): Promise<boolean>
  /**
   * Whether this story marks its chapters with a heading (序章, 第N章), so that talk
   * before and between chapters is not mistaken for one. Older stories do not.
   */
  chapterHeadings?(sessionId: string): Promise<boolean>
  readPath(sessionId: string): Promise<readonly string[] | null>
  readMessages(sessionId: string, messageIds: string[]): Promise<Message[]>
  listRecords(sessionId: string): Promise<NovelRecord[]>
  putRecord(sessionId: string, record: NovelRecord): Promise<void>
  /** Remove a record that has been taken over, such as a pending one once its chapter settles. */
  deleteRecord?(sessionId: string, recordId: string): Promise<void>
  /** `world` asks for the model that reasons about the world, with thinking on. */
  complete(prompt: string, role?: 'world'): Promise<{ text: string; model: string }>
  schedule(run: () => void, delayMs: number): void
  now(): number
  logError(message: string, error: unknown): void
  /** Later replies to wait for before recording a chapter. Defaults to {@link SETTLE_REPLIES}. */
  settleReplies?: number
}

function ledger(memory: NovelMemory): string {
  const characters = memory.characters
    .slice(-MAX_KNOWN_NAMES)
    .map((item) => `- ${item.name}：性格 ${item.traits.join('、') || '未记'}；状态 ${item.status || '未记'}`)
  const terms = memory.terms.slice(-MAX_KNOWN_NAMES).map((item) => `- ${item.name}：${item.description}`)
  const hooks = memory.openHooks.map((hook, index) => `- h${index + 1}：${hook.text}`)
  const facts = memory.facts.map((fact, index) => {
    const owner = fact.kind === 'anchor' ? '世界基准' : fact.owner || '主角'
    const mark = fact.inferred ? '，推定' : ''
    return `- f${index + 1}：${owner} / ${fact.name} = ${fact.value}（第${fact.chapter}章${mark}）`
  })
  const deleted = memory.deleted
    .filter((item) => item.target !== 'chapter' && item.target !== 'rollup')
    .map((item) => `- ${item.label}`)
  return `已记录的人物：
${characters.join('\n') || '（无）'}

已记录的名词：
${terms.join('\n') || '（无）'}

未回收的伏笔：
${hooks.join('\n') || '（无）'}

已记录的账目（更新时 owner 和 name 必须与此完全一致）：
${facts.join('\n') || '（无）'}

作者已删除、不要再记的内容：
${deleted.join('\n') || '（无）'}`
}

const FACT_EXAMPLE = '{"kind":"state","owner":"","name":"","value":"","change":"","stated":true,"evidence":""}'

const FACT_RULES = `账目（facts）：对数字和档次保持敏感。可量化的东西比人物性格更容易写错，要一条不漏。
- kind 为 state：属于某人、会随剧情变化的量。如金钱、物品数量、等级、段位、头衔、体力、伤势程度、债务、倒计时。owner 填人物名，正文用"你"称呼主角时填主角的名字，不知道名字就填"主角"。
- kind 为 anchor：世界的参考基准。如物价、工钱、税费、货币汇率（写成 1银=100铜）、距离、人口、等级制度、事件或任务的分级。owner 留空。
- 不一定是数字。"C级冒险者""B级灾害"这类档次也要记。
- 正文直接写明当前数额（如"你现在有：8银9铜"）：value 照抄，stated 为 true，change 留空。
- 正文写的是增减（如"付了十二铜"）：先找到账目里的上一次数额，算出新数额写进 value，change 写带正负号的变化量（如 -12铜），stated 为 false。一章里有多笔增减时只记一条，value 是结算后的结果，change 是合计。
- 正文既写了增减又写了结余（如"付了十二铜，还剩二十六铜"）：change 写增减，value 照抄正文的结余，stated 为 true。即使两者对不上也照抄，不要替正文改正，核对交给程序。
- 账目里已有的量，owner 和 name 要沿用，不要另起名字。没有变化的不要重复。
- value 保留原文的单位和写法。evidence 摘出体现这个数额或变化的原话。`

function worldPrompt(memory: NovelMemory): string {
  const story = memory.segments.slice(-MAX_WORLD_STORY_LINES).map((segment) => `- ${segment.text}`)
  return `你是一部长篇小说的世界观维护者。写作模型专注创意、节奏和文学性，随口写下的金额、物价、工钱、战力常常不成体系。世界的真实感和自洽靠你维护，你有权也有必要把它的数值观想清楚。

请先仔细推敲，再给出结论：
- 通读账目，思考这些量之间应有的关系：货币换算、收入与物价的比例、一笔钱够过多久、各等级的战力、报酬和人数、灾害等级对应的规模、距离与行程时间。
- 把写作时很可能用到、目前又缺失的关系补进 facts：basis 写它由哪些已知数据推出，value 写约数或范围（如 约30铜、C级约能敌三名士兵），kind 为 anchor 时 owner 留空。
- 账目里标"推定"的是你以前的结论。被新信息证伪或彼此矛盾的，用 amendments 改写或撤销：target 为 fact，ref 填账目编号（f1），action 为 amend 或 drop，amend 时 value 填新内容，reason 用一句话说明原因。
- 没有标"推定"的来自正文或作者，不能改，你的推定必须与它们全部自洽。
- 作者已删除的不要再补。
- 只补世界的规律，不替作者决定剧情走向，不增加人物或事件。
- 只补真正有用的，宁缺毋滥。世界已经自洽就输出空数组。

${ledger(memory)}

故事到目前为止：
${story.join('\n') || '（无）'}

只输出一个 JSON 对象，格式如下：
{"facts":[{"kind":"anchor","owner":"","name":"","value":"","basis":""}],"amendments":[{"target":"fact","ref":"f1","action":"amend","value":"","reason":""}]}`
}

function factsPrompt(memory: NovelMemory, reply: string, chapter: string): string {
  return `你是一部长篇小说的档案员。只从下面这一章里整理可量化的账目，不要做别的事，不要续写。

${FACT_RULES}

${ledger(memory)}

作者为本章做的选择：${reply || '（无）'}

本章正文：
${chapter}

只输出一个 JSON 对象，没有可记的就输出空数组，格式如下：
{"facts":[${FACT_EXAMPLE}]}`
}

function pendingFactLine(note: FactNote, index: number): string {
  const owner = note.kind === 'anchor' ? '世界基准' : note.owner || '主角'
  const amount = note.change ? `${note.change}${note.stated ? `，正文写结余 ${note.value}` : ''}` : `= ${note.value}`
  return `- p${index + 1}：${owner} / ${note.name} ${amount}${note.evidence ? `（原文：「${note.evidence}」）` : ''}`
}

/** The settled pass confirms what was noted when the chapter was written, instead of reading the numbers twice. */
function pendingFactsSection(notes: readonly FactNote[]): string {
  return `本章写完时已经记下的账目变化：
${notes.map(pendingFactLine).join('\n') || '（无）'}
- 这些已经记过，不要在 facts 里重复。
- 后续发展推翻、作者否定或改写了其中某条的，用 amendments 修正：target 为 fact，ref 填 p 编号，action 为 drop 或 amend，amend 时 value 填正确的变化量（如 -15铜）或数额。
- 本章还有漏记的，才按上面的规则写进 facts。`
}

function chapterPrompt(
  memory: NovelMemory,
  reply: string,
  chapter: string,
  followUps: string,
  discussion: string,
  pendingFacts?: readonly FactNote[]
): string {
  const previous = memory.chapters.findLast((item) => item.note.summary)?.note.summary
  return `你是一部长篇小说的档案员。这部小说由 AI 写章节、作者每轮回复来决定走向，所以 AI 写出来的东西不一定算数。
请根据"后续发展"判断本章内容是否尘埃落定，把已经落定、需要长期记住的内容整理成 JSON。不要续写故事。

判断方法：
- 作者的回复明确否定、要求重写，或后续剧情与之矛盾的：不要记。
- AI 抛出、等待作者接话的设定或悬念，如果后续作者完全没接：不要记。
- 作者顺着演下去、默许的：记。
- 作者改动过的：记改动后的版本。
- 正文已经明确写下的事实，即使后续暂时没再提到，也算数，要记。
- 如果作者否定或要求重写了本章的主要内容，令 superseded 为 true，其余字段留空。

记录规则：
- 只记录实际写出的内容，不要推测，不要创作。
- 每条记录的 evidence 必须是从"作者为本章做的选择""本章正文"或"后续发展"一字不差摘出的一句话。
- summary 用 80 到 150 字概括本章最终算数的事，保留人名、地名和因果。
- 只记重要人物、新出现或有变化的内容。没有变化的人物和名词不要重复。
- traits 只写稳定的性格特点；status 写此刻的位置、身体或处境；arc 写本章让这个人物发生的内在转变，没有就留空。
- speech 概括说话方式；quote 摘一句最能体现这个人物口吻的原文台词。
- 名词指世界观里的专有事物：地名、势力、物品、功法、规则等。
- 伏笔指埋下但尚未解释或回收的线索。hooksResolved 填本章回收了的已有伏笔编号。
- inScene 列出本章结尾时在场的人物。

${FACT_RULES}
- 只记到本章结束时的数额。后续发展里发生的增减留到记那一章时再算，不要提前算进来。
${pendingFacts ? `\n${pendingFactsSection(pendingFacts)}\n` : ''}
修正旧记录：
- 如果已记录的内容被本章或后续发展推翻、放弃，或写错了，用 amendments 修正。
- target 为 hook、character、term 或 fact；ref 填伏笔编号（h1）、账目编号（f1）或名称。
- action 为 drop（撤销）或 amend（改写）。amend 时 value 填新内容；改人物时 field 填 traits、speech 或 status。账目算错或被推翻时也用这里修正。
- reason 用一句话说明原因，evidence 摘体现这一变化的原话。
- 没有把握时不要修正。

${ledger(memory)}

上一章概要：${previous || '（无）'}

作者为本章做的选择：${reply || '（无）'}

${
  discussion
    ? `本章之前的讨论（作者和你在写正文之外的交流，如商量设定、复盘、调整方向）：
${discussion}

讨论里已经敲定的设定（人物、名词、世界规则、数值基准、剧情方向）按正常规则记录，evidence 摘讨论原话。还在商量、没有定论的不要记。

`
    : ''
}本章正文：
${chapter}

后续发展（只用来判断，不要把其中的新内容记到本章）：
${followUps || '（无）'}

只输出一个 JSON 对象，格式如下：
{"summary":"","superseded":false,"inScene":[""],"characters":[{"name":"","aliases":[""],"traits":[""],"speech":"","status":"","arc":"","quote":"","evidence":""}],"terms":[{"name":"","aliases":[""],"description":"","evidence":""}],"hooksPlanted":[{"text":"","evidence":""}],"hooksResolved":["h1"],"facts":[${FACT_EXAMPLE}],"amendments":[{"target":"hook","ref":"h1","action":"drop","field":"","value":"","reason":"","evidence":""}]}`
}

function rollupPrompt(chapters: readonly NovelChapterRecord[]): string {
  const text = chapters
    .filter((chapter) => chapter.note.summary)
    .map((chapter, index) => `${index + 1}. ${chapter.note.summary}`)
    .join('\n')
  return `下面是一部长篇小说连续 ${chapters.length} 章的概要。请合并成一段不超过 250 字的阶段总结，保留人名、关键事件和因果，不要写开场白。

${text}`
}

interface ChapterSpan {
  messages: Message[]
  chapter: Message
  /** What came after the chapter: the author's replies and the chapters they led to. */
  followUps: Message[]
  /** Whether the story marks its chapters, so that what is not one is discussion. */
  marking: boolean
}

/** A chapter written after the settled ones. */
interface UnsettledSpan {
  message: Message
  /** The chapter without its options. */
  body: string
  /** The author's reply that led to it. */
  reply: string
  textHash: string
}

const toUnsettled = (span: UnsettledSpan): UnsettledChapter => ({ messageId: span.message.id, textHash: span.textHash })

const emptyNote = (facts: FactNote[]): ChapterNote => ({
  summary: '',
  superseded: false,
  inScene: [],
  characters: [],
  terms: [],
  hooksPlanted: [],
  hooksResolved: [],
  amendments: [],
  facts,
})

const PENDING_REF = /^p\d+$/i

/** Rewrite a pending fact as the settled pass corrected it: a signed value is a change, anything else an amount. */
function amendPendingFact(note: FactNote, value: string): FactNote {
  return /^[+\-−]/.test(value)
    ? { ...note, change: value, stated: false }
    : { ...note, value, change: '', stated: true }
}

const textOf = (message: Message) => getMessageText(message, false, false).trim()

function isChapter(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    !message.isSummary &&
    !message.generating &&
    !message.error &&
    !message.errorCode &&
    textOf(message).length > 0
  )
}

/** The first chapter in `messages`: the last assistant message before a user reply. */
const HEADING =
  /^[#*\s【[（(]*(序章|序幕|序言|楔子|引子|前言|尾声|终章|第\s*[零〇一二三四五六七八九十百千两\d]+\s*[章回节幕卷篇])/

/** A reply that opens with a chapter heading, as opposed to talk about the story. */
export function hasChapterHeading(text: string): boolean {
  return HEADING.test(text.split('\n').find((line) => line.trim()) ?? '')
}

/** A story that should mark its chapters but has shown none within this many replies is not going to. */
const HEADING_PATIENCE = 8

/** Which replies count as chapters. A story that marks them leaves the rest as discussion. */
function chapterTest(messages: readonly Message[], marking: boolean, confirmed: boolean) {
  const headed = (message: Message) => isChapter(message) && hasChapterHeading(textOf(message))
  const active =
    marking &&
    (confirmed ||
      messages.some(headed) ||
      messages.filter((message) => message.role === 'assistant').length < HEADING_PATIENCE)
  return { active, isChapterMessage: active ? headed : isChapter }
}

function firstChapter(
  messages: readonly Message[],
  canEndList: boolean,
  isChapterMessage: (message: Message) => boolean
): number {
  return messages.findIndex((message, index) => {
    if (!isChapterMessage(message)) return false
    const next = messages[index + 1]
    return next ? next.role === 'user' : canEndList
  })
}

/** What followed a chapter through its `replies`-th reply and the chapter that answered it, once that exists. */
function settledFollowUps(after: readonly Message[], replies: number): Message[] | null {
  if (replies === 0) return []
  let seen = 0
  for (let index = 0; index < after.length; index++) {
    if (after[index].role === 'user' && ++seen === replies) {
      const next = after[index + 1]
      return after.slice(0, next && isChapter(next) ? index + 2 : index + 1)
    }
  }
  return null
}

function renderFollowUps(followUps: readonly Message[], marking: boolean): string {
  return followUps
    .map((message) => {
      if (message.role === 'user') return `作者回复：${textOf(message)}`
      const text = stripTrailingOptions(textOf(message))
      return marking && !hasChapterHeading(text) ? `后续讨论：${text}` : `后续章节：${text}`
    })
    .join('\n\n')
}

const MAX_DISCUSSION_CHARS = 8000

/** The talk that came before a chapter: settings agreed on, a recap, a change of direction. */
function renderDiscussion(messages: readonly Message[]): string {
  const talk = messages
    .map((message) => `${message.role === 'user' ? '作者' : '你'}：${textOf(message).slice(0, 2000)}`)
    .join('\n\n')
  return talk.length > MAX_DISCUSSION_CHARS ? talk.slice(-MAX_DISCUSSION_CHARS) : talk
}

/**
 * The background keeper of a long session. Once the author's replies show which way a
 * chapter settled, it records what stands, one chapter at a time and oldest gap first,
 * so a session turned on mid-way fills itself in. It never touches the conversation or
 * the request in flight: a failure here only means older chapters stay verbatim for now.
 */
export class NovelArchivist {
  private readonly active = new Set<string>()
  private readonly rerun = new Set<string>()
  private readonly scans = new Set<string>()
  private readonly statuses = new Map<string, NovelArchivistStatus>()
  private readonly listeners = new Set<(sessionId: string) => void>()
  private readonly pendingRuns = new Map<string, Promise<void>>()
  private readonly pendingAgain = new Set<string>()

  constructor(private readonly ports: NovelArchivistPorts) {}

  getStatus(sessionId: string): NovelArchivistStatus {
    return this.statuses.get(sessionId) ?? { state: 'idle', chapters: 0 }
  }

  subscribe(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Ask for a pass over the session. Safe to call any time; concurrent calls merge into one more pass. */
  schedule(sessionId: string): void {
    // The newest chapter's numbers are read at once; settling waits for the author's replies.
    void this.notePending(sessionId)
    if (this.active.has(sessionId)) {
      this.rerun.add(sessionId)
      return
    }
    this.ports.schedule(() => void this.run(sessionId), SETTLE_DELAY_MS)
  }

  /**
   * Read the numbers of chapters written since the last settled one, newest last, so
   * the next request knows the balance now and not two chapters ago. Resolves when
   * they are all read. A failure only leaves those chapters to the prose.
   */
  notePending(sessionId: string): Promise<void> {
    const running = this.pendingRuns.get(sessionId)
    if (running) {
      this.pendingAgain.add(sessionId)
      return running
    }
    const run = (async () => {
      try {
        do {
          this.pendingAgain.delete(sessionId)
          await this.drainPending(sessionId)
        } while (this.pendingAgain.has(sessionId))
      } catch (error) {
        this.ports.logError('Novel ledger could not read the newest chapter', error)
      } finally {
        this.pendingRuns.delete(sessionId)
        this.notify(sessionId)
      }
    })()
    this.pendingRuns.set(sessionId, run)
    return run
  }

  /** Before a request: let the newest chapter's numbers be read, but never hold writing up for long. */
  async ensurePending(sessionId: string, timeoutMs: number): Promise<void> {
    const run = this.notePending(sessionId)
    await Promise.race([run, new Promise<void>((resolve) => this.ports.schedule(resolve, timeoutMs))])
  }

  /** The settled memory, and the ledger with the newest chapters' changes added on. */
  async readLedger(
    sessionId: string,
    path: readonly string[]
  ): Promise<{ memory: NovelMemory; ledger: NovelLedger; records: NovelRecord[] }> {
    const records = await this.ports.listRecords(sessionId)
    const memory = foldNovelMemory(records, path)
    const spans = await this.readUnsettled(sessionId, path, memory)
    const ledger = spans
      ? foldNovelLedger(memory, records, spans.map(toUnsettled))
      : { ...foldNovelLedger(memory, records, []), missingFrom: memory.chapters.length + 1 }
    return { memory, ledger, records }
  }

  /** Go back over chapters recorded before numbers were kept. It costs a model call per chapter, so it is on request. */
  scanForFacts(sessionId: string): void {
    this.scans.add(sessionId)
    this.schedule(sessionId)
  }

  /** Run a pass now. Resolves when the session is caught up, or stopped on an error. */
  async run(sessionId: string): Promise<void> {
    if (this.active.has(sessionId)) {
      this.rerun.add(sessionId)
      return
    }
    this.active.add(sessionId)
    try {
      do {
        this.rerun.delete(sessionId)
        await this.drain(sessionId)
      } while (this.rerun.has(sessionId))
    } catch (error) {
      this.ports.logError('Novel archivist stopped', error)
      this.publish(sessionId, {
        state: 'failed',
        chapters: this.getStatus(sessionId).chapters,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.active.delete(sessionId)
    }
  }

  private publish(sessionId: string, status: NovelArchivistStatus): void {
    this.statuses.set(sessionId, status)
    this.notify(sessionId)
  }

  private notify(sessionId: string): void {
    for (const listener of this.listeners) listener(sessionId)
  }

  /**
   * Chapters after the settled ones, oldest first, as the path holds them now. Null
   * when the settled records are too far behind for this to be cheap.
   */
  private async readUnsettled(
    sessionId: string,
    path: readonly string[],
    memory: NovelMemory
  ): Promise<UnsettledSpan[] | null> {
    const start = memory.coveredThroughMessageId ? path.indexOf(memory.coveredThroughMessageId) + 1 : 0
    const ids = path.slice(start)
    if (ids.length > MAX_UNSETTLED_MESSAGES) return null
    const read = ids.length > 0 ? await this.ports.readMessages(sessionId, ids) : []
    const byId = new Map(read.map((message) => [message.id, message]))
    const messages = ids.flatMap((id) => byId.get(id) ?? [])
    const marking = (await this.ports.chapterHeadings?.(sessionId)) ?? false
    const { isChapterMessage } = chapterTest(messages, marking, memory.chapters.length > 0)
    const spans: UnsettledSpan[] = []
    let reply = ''
    messages.forEach((message, index) => {
      if (message.role === 'user') reply = textOf(message)
      const next = messages[index + 1]
      // Of several replies in a row, the last one is the chapter.
      if (!isChapterMessage(message) || (next && next.role !== 'user')) return
      const body = stripTrailingOptions(textOf(message))
      spans.push({ message, body, reply, textHash: chapterFingerprint(body) })
    })
    return spans
  }

  private async drainPending(sessionId: string): Promise<void> {
    if (!(await this.ports.isEnabled(sessionId))) return
    const path = await this.ports.readPath(sessionId)
    if (!path) return
    let records = await this.ports.listRecords(sessionId)
    const memory = foldNovelMemory(records, path)
    const spans = await this.readUnsettled(sessionId, path, memory)
    if (!spans || spans.length > MAX_PENDING_CHAPTERS) return
    for (const [index, span] of spans.entries()) {
      const stored = findPending(records, span.message.id)
      if (stored?.textHash === span.textHash) continue
      const ledger = foldNovelLedger(memory, records, spans.slice(0, index).map(toUnsettled))
      await this.ports.putRecord(sessionId, await this.readPendingFacts(span, memory, ledger))
      records = await this.ports.listRecords(sessionId)
      this.notify(sessionId)
    }
  }

  /** One small call: what this chapter changed, against the ledger as it stands after the chapters before it. */
  private async readPendingFacts(
    span: UnsettledSpan,
    memory: NovelMemory,
    ledger: NovelLedger
  ): Promise<NovelPendingRecord> {
    const prompt = factsPrompt({ ...memory, facts: ledger.facts }, span.reply, span.body)
    let result = await this.ports.complete(prompt)
    let facts = parseFactsReply(result.text)
    if (!facts) {
      result = await this.ports.complete(prompt)
      facts = parseFactsReply(result.text)
    }
    if (!facts) throw new Error('The background model did not return valid JSON')
    return {
      kind: 'pending',
      id: pendingRecordId(span.message.id),
      messageId: span.message.id,
      textHash: span.textHash,
      facts: keepEvidenced(emptyNote(facts), `${span.reply}\n${span.body}`).facts,
      model: result.model,
      createdAt: this.ports.now(),
    }
  }

  private async drain(sessionId: string): Promise<void> {
    if (!(await this.ports.isEnabled(sessionId))) return
    while (true) {
      const path = await this.ports.readPath(sessionId)
      if (!path) return
      const records = await this.ports.listRecords(sessionId)
      const memory = foldNovelMemory(records, path)

      const start = memory.coveredThroughMessageId ? path.indexOf(memory.coveredThroughMessageId) + 1 : 0
      const marking = (await this.ports.chapterHeadings?.(sessionId)) ?? false
      const span = await this.findNextChapter(sessionId, path, start, marking, memory.chapters.length > 0)
      if (span) {
        this.publish(sessionId, { state: 'running', chapters: memory.chapters.length })
        await this.ports.putRecord(sessionId, await this.recordChapter(span, memory, records))
        // Its record has taken the pending changes over; keeping them would count them twice.
        if (findPending(records, span.chapter.id)) {
          await this.ports.deleteRecord?.(sessionId, pendingRecordId(span.chapter.id))
        }
        continue
      }
      const unscanned = this.scans.has(sessionId) ? memory.chapters.find((item) => !item.note.facts) : undefined
      if (unscanned) {
        this.publish(sessionId, { state: 'running', chapters: memory.chapters.length })
        await this.ports.putRecord(sessionId, await this.scanFacts(sessionId, unscanned, records, path))
        continue
      }
      this.scans.delete(sessionId)
      if (needsWorldPass(memory)) {
        this.publish(sessionId, { state: 'running', chapters: memory.chapters.length, task: 'world' })
        await this.ports.putRecord(sessionId, await this.recordWorld(memory))
        continue
      }
      const stretch = nextStretch(memory, records)
      if (stretch) {
        this.publish(sessionId, { state: 'running', chapters: memory.chapters.length })
        await this.ports.putRecord(sessionId, await this.recordRollup(stretch, records))
        continue
      }
      this.publish(sessionId, { state: 'idle', chapters: memory.chapters.length })
      // Caught up: the newest chapters may now be close enough to read ahead.
      void this.notePending(sessionId)
      return
    }
  }

  /**
   * The messages from `start` through the next chapter that has settled, and what
   * followed it. Nothing is returned until enough later replies exist.
   */
  private async findNextChapter(
    sessionId: string,
    path: readonly string[],
    start: number,
    marking: boolean,
    confirmed: boolean
  ): Promise<ChapterSpan | null> {
    const messages: Message[] = []
    for (let offset = start; offset < path.length; offset += READ_BATCH) {
      const ids = path.slice(offset, offset + READ_BATCH)
      const read = await this.ports.readMessages(sessionId, ids)
      const byId = new Map(read.map((message) => [message.id, message]))
      const batch = ids.flatMap((id) => byId.get(id) ?? [])
      // A chapter still being written ends what can be read; finished ones before it still count.
      const generating = batch.findIndex((message) => message.generating)
      messages.push(...(generating >= 0 ? batch.slice(0, generating) : batch))
      const reachedEnd = generating < 0 && offset + READ_BATCH >= path.length
      const { active, isChapterMessage } = chapterTest(messages, marking, confirmed)
      const index = firstChapter(messages, reachedEnd, isChapterMessage)
      const followUps =
        index >= 0 ? settledFollowUps(messages.slice(index + 1), this.ports.settleReplies ?? SETTLE_REPLIES) : null
      if (followUps) {
        return { messages: messages.slice(0, index + 1), chapter: messages[index], followUps, marking: active }
      }
      if (generating >= 0) return null
    }
    return null
  }

  private async recordChapter(
    span: ChapterSpan,
    memory: NovelMemory,
    records: readonly NovelRecord[]
  ): Promise<NovelChapterRecord> {
    const body = stripTrailingOptions(textOf(span.chapter))
    const lastReply = span.messages.findLast((message) => message.role === 'user')
    const reply = lastReply ? textOf(lastReply) : ''
    const followUps = renderFollowUps(span.followUps, span.marking)
    const discussion = span.marking
      ? renderDiscussion(span.messages.slice(0, -1).filter((message) => message !== lastReply))
      : ''
    const stored = findPending(records, span.chapter.id)
    const pending = stored?.textHash === chapterFingerprint(body) ? stored : undefined
    const prompt = chapterPrompt(memory, reply, body, followUps, discussion, pending?.facts)

    let result = await this.ports.complete(prompt)
    let parsed = parseArchivistReply(result.text)
    if (!parsed) {
      result = await this.ports.complete(prompt)
      parsed = parseArchivistReply(result.text)
    }
    if (!parsed) throw new Error('The background model did not return valid JSON')

    const kept = keepEvidenced(parsed, `${reply}\n${discussion}\n${body}\n${followUps}`)
    const {
      hooksResolved,
      amendments: allAmendments,
      superseded: _superseded,
      ...note
    } = parsed.superseded
      ? { ...kept, summary: '', inScene: [], characters: [], terms: [], hooksPlanted: [], hooksResolved: [], facts: [] }
      : kept
    const amendments = allAmendments.filter((item) => !(item.target === 'fact' && PENDING_REF.test(item.ref)))
    const facts = parsed.superseded
      ? []
      : pending
        ? confirmPending(pending, allAmendments, note.facts, memory)
        : settleFactNotes(note.facts, memory)
    return {
      kind: 'chapter',
      id: span.chapter.id,
      messageId: span.chapter.id,
      covers: span.messages.map((message) => message.id),
      note: { ...note, facts },
      amendments: amendments.flatMap((item): NovelAmendment[] => {
        const key = amendmentKey(item, memory)
        if (!key) return []
        return [
          { target: item.target, key, action: item.action, field: item.field, value: item.value, reason: item.reason },
        ]
      }),
      resolvedHookIds: hooksResolved.flatMap((label) => {
        const hook = memory.openHooks[hookIndex(label)]
        return hook ? [hook.id] : []
      }),
      model: result.model,
      createdAt: this.ports.now(),
    }
  }

  /** Read the numbers out of a chapter recorded before they were kept, oldest first so sums carry over. */
  private async scanFacts(
    sessionId: string,
    chapter: NovelChapterRecord,
    records: NovelRecord[],
    path: readonly string[]
  ): Promise<NovelChapterRecord> {
    const before = path.slice(0, path.indexOf(chapter.covers[0]))
    const memory = foldNovelMemory(records, before)
    const messages = await this.ports.readMessages(sessionId, chapter.covers)
    const body = stripTrailingOptions(
      textOf(messages.find((message) => message.id === chapter.messageId) ?? messages[0])
    )
    const lastReply = messages.findLast((message) => message.role === 'user')
    const reply = lastReply ? textOf(lastReply) : ''

    const prompt = factsPrompt(memory, reply, body)
    const facts =
      parseFactsReply((await this.ports.complete(prompt)).text) ??
      parseFactsReply((await this.ports.complete(prompt)).text)
    if (!facts) throw new Error('The background model did not return valid JSON')
    const { facts: kept } = keepEvidenced(emptyNote(facts), `${reply}\n${body}`)
    return { ...chapter, note: { ...chapter.note, facts: settleFactNotes(kept, memory) } }
  }

  /** Think the world through once. Only what it may touch is kept: it adds inferences and revises its own. */
  private async recordWorld(memory: NovelMemory): Promise<NovelWorldRecord> {
    const prompt = worldPrompt(memory)
    let result = await this.ports.complete(prompt, 'world')
    let parsed = parseWorldReply(result.text)
    if (!parsed) {
      result = await this.ports.complete(prompt, 'world')
      parsed = parseWorldReply(result.text)
    }
    if (!parsed) throw new Error('The background model did not return valid JSON')

    const chapter = memory.chapters[memory.chapters.length - 1]
    return {
      kind: 'world',
      id: `world:${chapter.id}`,
      chapterId: chapter.id,
      facts: parsed.facts
        .filter((fact) => fact.name && fact.value && fact.basis)
        .slice(0, MAX_INFERRED_PER_PASS)
        .map((fact) => ({ ...fact, inferred: true, stated: true, change: '', evidence: '' })),
      amendments: parsed.amendments.flatMap((item): NovelAmendment[] => {
        const fact = item.target === 'fact' ? memory.facts[hookIndex(item.ref)] : undefined
        if (!fact?.inferred || (item.action === 'amend' && !item.value)) return []
        return [
          { target: 'fact', key: fact.key, action: item.action, field: '', value: item.value, reason: item.reason },
        ]
      }),
      model: result.model,
      createdAt: this.ports.now(),
    }
  }

  private async recordRollup(chapters: NovelChapterRecord[], records: NovelRecord[]): Promise<NovelRollupRecord> {
    const result = await this.ports.complete(rollupPrompt(chapters))
    const summary = result.text.trim()
    if (!summary) throw new Error('The background model returned an empty summary')
    return {
      kind: 'rollup',
      id: `rollup:${chapters[0].id}`,
      chapterIds: chapters.map((chapter) => chapter.id),
      summary,
      model: result.model,
      // Never older than the edit that called for it, or it would stay out of date and be redone forever.
      createdAt: Math.max(this.ports.now(), ...records.map((record) => record.createdAt)),
    }
  }
}

const hookIndex = (label: string) => Number(label.replace(/^[hf]/i, '')) - 1

function amendmentKey(item: { target: string; ref: string }, memory: NovelMemory): string | undefined {
  if (item.target === 'hook') return memory.openHooks[hookIndex(item.ref)]?.id
  if (item.target === 'fact') return memory.facts[hookIndex(item.ref)]?.key
  return item.ref
}

function findPending(records: readonly NovelRecord[], messageId: string): NovelPendingRecord | undefined {
  const id = pendingRecordId(messageId)
  return records.find((record): record is NovelPendingRecord => record.kind === 'pending' && record.id === id)
}

/**
 * The settled facts of a chapter whose numbers were noted when it was written: those
 * notes, less what the author's replies overturned, plus only what was missed. A
 * number the settled pass reports again is left out, or its change would count twice.
 * The author's choices on conflicts carry over.
 */
function confirmPending(
  pending: NovelPendingRecord,
  amendments: ChapterNote['amendments'],
  reported: readonly FactNote[],
  memory: NovelMemory
) {
  const corrections = new Map(
    amendments
      .filter((item) => item.target === 'fact' && PENDING_REF.test(item.ref))
      .map((item) => [Number(item.ref.slice(1)) - 1, item] as const)
  )
  const confirmed = pending.facts.flatMap((note, index) => {
    const correction = corrections.get(index)
    if (!correction) return [note]
    if (correction.action === 'drop') return []
    return correction.value ? [amendPendingFact(note, correction.value)] : [note]
  })
  const noted = new Set(pending.facts.map((note) => factNoteKey(note, memory)))
  const missed = reported.filter((note) => !noted.has(factNoteKey(note, memory)))
  return settleFactNotes([...confirmed, ...missed], memory, pending.resolutions)
}

/** Whether new numbers have piled up, or it has simply been a while. */
function needsWorldPass(memory: NovelMemory): boolean {
  const gap = memory.chapters.length - memory.worldChapter
  if (memory.facts.length === 0 || gap < WORLD_MIN_GAP) return false
  const fresh = memory.facts.some((fact) => !fact.inferred && fact.chapter > memory.worldChapter)
  return fresh || gap >= WORLD_MAX_GAP
}

/** The oldest stretch of chapters without a summary, once at least as many newer chapters follow it. */
function nextStretch(memory: NovelMemory, records: readonly NovelRecord[]): NovelChapterRecord[] | null {
  const rolled = new Set(
    records.flatMap((record) => (record.kind === 'rollup' && isRollupCurrent(record, records) ? record.chapterIds : []))
  )
  const first = memory.chapters.findIndex((chapter) => !rolled.has(chapter.id))
  if (first < 0 || memory.chapters.length - first < ROLLUP_CHAPTERS * 2) return null
  return memory.chapters.slice(first, first + ROLLUP_CHAPTERS)
}
