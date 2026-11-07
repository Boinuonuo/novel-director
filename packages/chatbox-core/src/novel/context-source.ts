import type { AssemblyManifest, LoreEntry, NovelPromptLanguage, StorySegment, TierShares } from './types'

/**
 * What the background bookkeeping has recorded for one session, as needed for one
 * request. Hosts read it from their own store; the core never touches storage.
 */
export interface NovelContextSnapshot {
  lore: LoreEntry[]
  /** The story so far, paragraphs separated by blank lines, oldest first. */
  storySoFar?: string
  /** Recorded story, oldest first. */
  storySegments?: StorySegment[]
  /** The newest message the story so far accounts for. Older messages may leave the verbatim window. */
  coveredThroughMessageId?: string
  /** Rendered state records, most important first. */
  stateLines?: string[]
  /** Total token budget for one writer request. Defaults to {@link DEFAULT_NOVEL_BUDGET_TOKENS}. */
  budgetTokens?: number
  /** Wording for headings the assembler adds. Default 'zh'. */
  language?: NovelPromptLanguage
  shares?: Partial<TierShares>
  scanDepth?: number
  /** Sticky lore counters carried over from the previous request. */
  stickyRemaining?: Record<string, number>
}

export interface NovelAssemblyRecord {
  manifest: AssemblyManifest
  /** To be fed back as `stickyRemaining` on the next request. */
  nextStickyRemaining: Record<string, number>
}

export interface NovelContextSourcePort {
  /**
   * Read the session's current records. Returning undefined (or rejecting) leaves the
   * request exactly as it would be without this pipeline, so a broken store never blocks writing.
   */
  read(sessionId: string, pathMessageIds?: readonly string[]): Promise<NovelContextSnapshot | undefined>
  /** Whether the records keep up with this session, so that auto compaction has nothing left to do. */
  coversHistory?(sessionId: string): Promise<boolean>
  /** A chapter finished generating; the bookkeeping can run. */
  onChapterFinished?(sessionId: string): void
  /** Called after each assembly so the host can persist sticky counters and show what was sent. */
  recordAssembly?(sessionId: string, record: NovelAssemblyRecord): void | Promise<void>
}
