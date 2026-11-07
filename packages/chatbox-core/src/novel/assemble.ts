import { fitGreedy, fitPrefix, resolveTierCaps, splitParagraphs, trimParagraphsFromFront } from './budget'
import { activateLore } from './lorebook'
import type {
  ActivatedLore,
  LoreEntry,
  LoreManifestItem,
  NovelAssembly,
  NovelAssemblyInput,
  NovelPromptLanguage,
  NovelTurn,
} from './types'

const DEFAULT_SCAN_DEPTH = 4
/** The verbatim window's start moves by this many turns at a time: three chapters and their replies. */
const WINDOW_CHUNK_TURNS = 6
/** Two chapters and their replies always stay verbatim, however tight the budget, to carry the voice. */
const MIN_VERBATIM_TURNS = 4

/**
 * Wording the model sees around the author's own content. Chinese is the default
 * because this client is built for Chinese fiction and the writer's replies follow
 * the language of its prompt. Tag names stay ASCII: they are structure, not prose.
 */
interface PromptLabels {
  worldRules: string
  currentState: string
  worldInfo: string
  preamble: string
}

const PROMPT_LABELS: Record<NovelPromptLanguage, PromptLabels> = {
  zh: {
    worldRules: '## 世界规则',
    currentState: '## 当前状态',
    worldInfo: '## 相关设定',
    preamble: '以下是帮助你保持前后连贯的参考笔记，不属于故事正文。不要引用，也不要在回复中提及它们。',
  },
  en: {
    worldRules: '## World rules',
    currentState: '## Current state',
    worldInfo: '## World info',
    preamble: 'Reference notes for continuity. They are not part of the story text; never quote them or mention them.',
  },
}

function loreName(entry: LoreEntry): string {
  return entry.name?.trim() || entry.keys.find((key) => key.trim()) || entry.id
}

function renderLoreItem(entry: LoreEntry): string {
  return `### ${loreName(entry)}\n${entry.content.trim()}`
}

/** Tier 0: constant lore. Stable across turns so provider caches hold. */
function renderConstantLore(labels: PromptLabels, constants: readonly ActivatedLore[]): string {
  if (constants.length === 0) return ''
  return `${labels.worldRules}\n\n${constants.map((item) => renderLoreItem(item.entry)).join('\n\n')}`
}

/** Tier 3: derived per turn at send time and never stored in the conversation. */
function renderVolatile(labels: PromptLabels, stateLines: readonly string[], lore: readonly ActivatedLore[]): string {
  if (stateLines.length === 0 && lore.length === 0) return ''
  const parts = ['<story_context>', labels.preamble]
  if (stateLines.length > 0) {
    parts.push('', labels.currentState, ...stateLines.map((line) => (line.startsWith('- ') ? line : `- ${line}`)))
  }
  if (lore.length > 0) {
    parts.push('', labels.worldInfo, lore.map((item) => renderLoreItem(item.entry)).join('\n\n'))
  }
  parts.push('</story_context>')
  return parts.join('\n')
}

/**
 * The first turn to keep verbatim. Unrecorded turns are never dropped, so with no
 * recorded turns this is 0 and the history stays whole.
 *
 * The start moves in whole chunks: sliding it every turn would rewrite the front of
 * the request each time and lose the provider's prompt cache on all of it. The cost
 * is briefly keeping up to one chunk fewer turns than would fit.
 */
function selectWindowStart(
  turns: readonly NovelTurn[],
  roomTokens: number,
  countTokens: NovelAssemblyInput['countTokens'],
  coveredThroughTurnId: string | undefined
): number {
  const coveredIndex = coveredThroughTurnId ? turns.findIndex((turn) => turn.id === coveredThroughTurnId) : -1
  if (coveredIndex < 0 || turns.length === 0) return 0

  const lastIndex = turns.length - 1
  let start = lastIndex
  let tokens = countTokens(turns[lastIndex].text)
  while (start > 0) {
    const cost = countTokens(turns[start - 1].text)
    if (tokens + cost > roomTokens) break
    start--
    tokens += cost
  }
  // The one place that guarantees it: nothing newer than the recorded turn ever leaves.
  const latestAllowed = Math.max(0, Math.min(coveredIndex + 1, lastIndex - MIN_VERBATIM_TURNS + 1))
  return Math.min(Math.ceil(start / WINDOW_CHUNK_TURNS) * WINDOW_CHUNK_TURNS, latestAllowed)
}

/**
 * Build the extra context for one request, inside a token budget.
 *
 * - T0 constant lore, within its share, after what the system slot already holds.
 * - T1 story so far: oldest paragraphs are dropped first.
 * - T3 volatile: state first, then triggered lore by priority; lowest-priority lore goes first.
 * - T2 verbatim turns: only recorded turns may leave, oldest first, in whole chunks. The
 *   last turn (the author's current reply) is always kept.
 *
 * T1 and T3 are reserved at their full caps, not their current size, so the verbatim
 * window does not move just because one turn's context came out shorter.
 */
export function assembleNovelContext(input: NovelAssemblyInput): NovelAssembly {
  const { countTokens } = input
  const total = Number.isFinite(input.totalBudgetTokens) ? Math.max(0, Math.floor(input.totalBudgetTokens)) : 0
  const caps = resolveTierCaps(total, input.shares)
  const labels = PROMPT_LABELS[input.language ?? 'zh']
  const turns = input.turns
  const scanDepth = Math.max(1, Math.floor(input.scanDepth ?? DEFAULT_SCAN_DEPTH))

  const { activated, nextStickyRemaining } = activateLore(
    input.lore,
    turns.slice(-scanDepth).map((turn) => turn.text),
    { stickyRemaining: input.stickyRemaining, maxRecursionDepth: input.maxRecursionDepth }
  )
  const constants = activated.filter((item) => item.reason === 'constant')
  const triggered = activated.filter((item) => item.reason !== 'constant')

  const systemPrompt = input.systemPrompt.trim()
  const withSystem = (lore: string) => [systemPrompt, lore].filter(Boolean).join('\n\n')
  const t0 = fitGreedy(constants, (kept) => countTokens(withSystem(renderConstantLore(labels, kept))), caps.t0)
  const constantLoreText = renderConstantLore(labels, t0.kept)
  const t0Tokens = countTokens(withSystem(constantLoreText))

  const stateLines = (input.stateLines ?? []).filter((line) => line.trim())
  const state = fitPrefix(stateLines, (kept) => countTokens(renderVolatile(labels, kept, [])), caps.t3)
  const lore = fitGreedy(triggered, (kept) => countTokens(renderVolatile(labels, state.kept, kept)), caps.t3)
  const volatileBlock = renderVolatile(labels, state.kept, lore.kept)
  const t3Tokens = volatileBlock ? countTokens(volatileBlock) : 0

  const room = Math.max(0, total - t0Tokens - caps.t1 - caps.t3)
  const windowStart = selectWindowStart(turns, room, countTokens, input.coveredThroughTurnId)
  const keptTurns = turns.slice(windowStart)
  const t2Tokens = keptTurns.reduce((sum, turn) => sum + countTokens(turn.text), 0)

  // A turn still in the window speaks for itself; only what has left it needs telling.
  const stillVerbatim = new Set(keptTurns.map((turn) => turn.id))
  const recorded = (input.storySegments ?? []).filter((segment) => !stillVerbatim.has(segment.throughTurnId))
  const paragraphs = [...splitParagraphs(input.storySoFar ?? ''), ...recorded.map((segment) => segment.text)]
  const summary = trimParagraphsFromFront(paragraphs, countTokens, caps.t1)
  const storySoFar = summary.kept.join('\n\n')
  const t1Tokens = storySoFar ? countTokens(storySoFar) : 0

  const includedLore = new Set([...t0.kept, ...lore.kept].map((item) => item.entry.id))
  const loreManifest: LoreManifestItem[] = activated.map((item) => {
    const included = includedLore.has(item.entry.id)
    return {
      id: item.entry.id,
      name: loreName(item.entry),
      reason: item.reason,
      ...(item.matchedKey !== undefined ? { matchedKey: item.matchedKey } : {}),
      tokens: countTokens(renderLoreItem(item.entry)),
      included,
      ...(included ? {} : { droppedFor: 'budget' as const }),
    }
  })

  const usedTokens = t0Tokens + t1Tokens + t3Tokens + t2Tokens
  return {
    constantLoreText,
    storySoFar,
    turns: keptTurns,
    volatileBlock,
    nextStickyRemaining,
    manifest: {
      totalBudgetTokens: total,
      usedTokens,
      overBudget: usedTokens > total,
      tiers: {
        t0: { tokens: t0Tokens, cap: caps.t0 },
        t1: { tokens: t1Tokens, cap: caps.t1 },
        t2: { tokens: t2Tokens, cap: room },
        t3: { tokens: t3Tokens, cap: caps.t3 },
      },
      lore: loreManifest,
      keptTurnIds: keptTurns.map((turn) => turn.id),
      droppedTurnCount: turns.length - keptTurns.length,
      droppedSummaryParagraphs: summary.droppedCount,
      summaryTruncated: summary.truncated,
      droppedStateLines: state.dropped.length,
    },
  }
}
