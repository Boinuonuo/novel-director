/**
 * Pure data types for the novel-writing context pipeline. Nothing here depends
 * on sessions, storage or a tokenizer: hosts feed plain data in and receive plain
 * data back, which keeps assembly deterministic and unit-testable.
 */

/** How secondary keys combine with a primary key hit. */
export type LoreSecondaryLogic = 'andAny' | 'andAll' | 'notAny' | 'notAll'

export interface LoreEntry {
  id: string
  /** Display label; falls back to the first key. */
  name?: string
  /** Primary keys. A plain string, or `/pattern/flags` for a regular expression. */
  keys: string[]
  /** Optional second condition evaluated with {@link secondaryLogic}. */
  secondaryKeys?: string[]
  secondaryLogic?: LoreSecondaryLogic
  content: string
  /** Always active and rendered in the stable system tier. */
  constant?: boolean
  enabled?: boolean
  /** Higher wins when the budget is tight and sorts first in output. Default 0. */
  priority?: number
  /** After a keyword hit, stay active for this many further turns. */
  sticky?: number
  caseSensitive?: boolean
  /** This entry can never be activated by another entry's content. */
  excludeFromRecursion?: boolean
  /** Unknown fields from imports, kept so export can round-trip them. */
  extensions?: Record<string, unknown>
}

export type LoreActivationReason = 'constant' | 'keyword' | 'recursive' | 'sticky'

export interface ActivatedLore {
  entry: LoreEntry
  reason: LoreActivationReason
  /** The key (or secondary-less key) that matched, for the inspector. */
  matchedKey?: string
  /** 0 for direct hits, n for the nth recursion pass. */
  depth: number
}

export interface LoreActivationOptions {
  /** Maximum extra passes that scan activated entries' content. Default 2; 0 disables recursion. */
  maxRecursionDepth?: number
  /** Remaining sticky turns per entry id, as returned by the previous call. */
  stickyRemaining?: Readonly<Record<string, number>>
}

export interface LoreActivationResult {
  /** Deterministic order: priority descending, then id ascending. */
  activated: ActivatedLore[]
  /** Pass this to the next turn's call. Only contains positive counts. */
  nextStickyRemaining: Record<string, number>
}

export type TurnRole = 'user' | 'assistant'

/** One conversation turn as the assembler sees it. */
export interface NovelTurn {
  id: string
  role: TurnRole
  text: string
}

export type CountTokens = (text: string) => number

/** Share of the total budget each tier may use. T2 (verbatim prose) takes the remainder. */
export interface TierShares {
  /** System prompt, style guide and constant lore. */
  t0: number
  /** Story so far. */
  t1: number
  /** State, triggered lore and recalled excerpts. */
  t3: number
}

export const DEFAULT_TIER_SHARES: Readonly<TierShares> = { t0: 0.1, t1: 0.15, t3: 0.25 }

/** Default total budget for one writer request. */
export const DEFAULT_NOVEL_BUDGET_TOKENS = 60_000

/** One piece of the story so far, and the newest turn it accounts for. */
export interface StorySegment {
  throughTurnId: string
  text: string
}

/** Language of the wording the assembler adds around the author's own content. */
export type NovelPromptLanguage = 'zh' | 'en'

export interface NovelAssemblyInput {
  totalBudgetTokens: number
  /** Wording for section headings and the context preamble. Default 'zh'. */
  language?: NovelPromptLanguage
  countTokens: CountTokens
  /** Everything already in the request's system slot. Counted against the budget, never changed. */
  systemPrompt: string
  lore: readonly LoreEntry[]
  /** Oldest first. The last turn is the author's current reply and is always kept. */
  turns: readonly NovelTurn[]
  /**
   * The newest turn whose content is safely recorded, so that it and anything older may
   * leave the verbatim window. Without it, or when it is not in `turns`, no turn is dropped
   * and the request stays exactly as long as it would be without this pipeline.
   */
  coveredThroughTurnId?: string
  /** Hierarchical story-so-far, paragraphs separated by blank lines, oldest first. */
  storySoFar?: string
  /** Recorded story, oldest first. A segment is used once its turns have left the verbatim window. */
  storySegments?: readonly StorySegment[]
  /** Rendered state records, most important first. */
  stateLines?: readonly string[]
  /** How many recent turns are scanned for lore keywords. Default 4. */
  scanDepth?: number
  shares?: Partial<TierShares>
  stickyRemaining?: Readonly<Record<string, number>>
  maxRecursionDepth?: number
}

export type DropReason = 'budget'

export interface LoreManifestItem {
  id: string
  name: string
  reason: LoreActivationReason
  matchedKey?: string
  tokens: number
  included: boolean
  droppedFor?: DropReason
}

export interface TierUsage {
  tokens: number
  cap: number
}

export interface AssemblyManifest {
  totalBudgetTokens: number
  usedTokens: number
  /** True when content that may not be dropped (system text, unrecorded turns) exceeds the budget. */
  overBudget: boolean
  tiers: { t0: TierUsage; t1: TierUsage; t2: TierUsage; t3: TierUsage }
  lore: LoreManifestItem[]
  keptTurnIds: string[]
  droppedTurnCount: number
  droppedSummaryParagraphs: number
  /** True when the newest summary paragraph alone exceeded its tier and was cut short. */
  summaryTruncated: boolean
  droppedStateLines: number
}

export interface NovelAssembly {
  /** Tier 0: constant lore to add to the system slot. Stable across turns, so provider caches hold. */
  constantLoreText: string
  /** Tier 1: the story so far, after trimming. Empty when there is none. */
  storySoFar: string
  /** Tier 2: verbatim recent turns, oldest first. */
  turns: NovelTurn[]
  /** Tier 3: rebuilt every turn and never persisted. Empty when nothing is relevant. */
  volatileBlock: string
  nextStickyRemaining: Record<string, number>
  manifest: AssemblyManifest
}
