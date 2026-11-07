import {
  addNovelContext,
  applyNovelHistory,
  assembleNovelContext,
  estimateNovelTokens,
  type NovelContextSourcePort,
  resolveNovelBudget,
  splitNovelHistory,
} from '@chatbox/core/novel'
import type { ModelInterface } from '@shared/models/types'
import { getTokenizerType } from '@shared/token-estimation/tokenizer'
import type { Message, SessionSettings, Settings } from '@shared/types'
import { getLogger } from '@/lib/utils'
import { resolveCompactionBudget } from '@/packages/context-management/compaction-detector'
import { getConfiguredContextWindow, getEffectiveMaxOutputTokens } from '@/packages/context-management/context-pressure'

const log = getLogger('novel-scaffold')

/** A failing logger must not turn a bookkeeping problem into a failed request. */
function warn(message: string, detail: Record<string, unknown>): void {
  try {
    log.warn(message, detail)
  } catch {
    // Nothing further can be reported, and the request is more important.
  }
}

export interface NovelScaffoldOptions {
  sessionId: string
  settings: SessionSettings
  globalSettings: Settings
  model: ModelInterface
  /** The prompt the normal pipeline built, attachments and all. */
  promptMsgs: Message[]
  /** The system instructions the normal pipeline built: tool guidance, memories. */
  instructions: string
  /** The conversation's message path, which decides which records apply. */
  pathMessageIds?: readonly string[]
  source?: NovelContextSourcePort
}

/** What long-form support adds to one request. Everything else in it stays as it was. */
export interface NovelScaffold {
  promptMsgs: Message[]
  instructions: string
  addContext(messages: Message[]): Message[]
}

/**
 * Prepare what long-form support adds to a request, on top of what the normal
 * pipeline built: stored lore, the story so far, and a per-turn context block.
 *
 * It only ever adds. With no records, or when the store fails, this returns
 * undefined and the request is exactly the one vanilla Chatbox would send: a
 * problem in the bookkeeping must never get in the way of writing.
 */
export async function prepareNovelScaffold(options: NovelScaffoldOptions): Promise<NovelScaffold | undefined> {
  const { sessionId, settings, globalSettings, model, promptMsgs, instructions, pathMessageIds, source } = options
  try {
    const snapshot = await source?.read(sessionId, pathMessageIds)
    if (!snapshot) return undefined

    const modelId = settings.modelId ?? model.modelId
    const tokenizerType = getTokenizerType(settings.provider ? { provider: settings.provider, modelId } : undefined)
    const window = resolveCompactionBudget(
      modelId,
      { compactionThreshold: globalSettings.compactionThreshold },
      getConfiguredContextWindow(globalSettings, settings.provider, modelId),
      getEffectiveMaxOutputTokens(globalSettings, settings.provider, modelId, settings.maxTokens)
    )

    const history = splitNovelHistory(promptMsgs)
    const language = snapshot.language ?? 'zh'
    const assembly = assembleNovelContext({
      totalBudgetTokens: resolveNovelBudget(snapshot.budgetTokens, window?.usableTokens),
      countTokens: (text) => estimateNovelTokens(text, tokenizerType),
      language,
      systemPrompt: [history.systemPrompt, instructions].filter(Boolean).join('\n\n'),
      lore: snapshot.lore,
      turns: history.turns,
      coveredThroughTurnId: snapshot.coveredThroughMessageId,
      storySoFar: snapshot.storySoFar,
      storySegments: snapshot.storySegments,
      stateLines: snapshot.stateLines,
      scanDepth: snapshot.scanDepth,
      shares: snapshot.shares,
      stickyRemaining: snapshot.stickyRemaining,
    })

    void Promise.resolve(
      source?.recordAssembly?.(sessionId, {
        manifest: assembly.manifest,
        nextStickyRemaining: assembly.nextStickyRemaining,
      })
    ).catch((error: unknown) => warn('Failed to record novel assembly', { error }))

    const replyMessageId = history.turns.findLast((turn) => turn.role === 'user')?.id
    return {
      promptMsgs: applyNovelHistory(promptMsgs, history, assembly, language),
      // Ahead of tool guidance, which can change between turns, so the lore stays in the cached prefix.
      instructions: [assembly.constantLoreText, instructions].filter(Boolean).join('\n\n'),
      addContext: (messages) => addNovelContext(messages, assembly.volatileBlock, replyMessageId),
    }
  } catch (error) {
    warn('Novel scaffold failed; sending the request without it', { sessionId, error })
    return undefined
  }
}
