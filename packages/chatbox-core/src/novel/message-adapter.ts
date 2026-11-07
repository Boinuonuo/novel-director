import { getContextHistoryStartNote } from '@shared/context/compaction-handoff'
import { getMessageText } from '@shared/utils/message'
import type { Message } from '../types'
import type { NovelAssembly, NovelPromptLanguage, NovelTurn } from './types'

/** Wording that frames the story-so-far message. Chinese by default, like the rest of the prompt. */
const STORY_SO_FAR_HEADING: Record<NovelPromptLanguage, string> = {
  zh: '【前情提要】以下是此前剧情的概要，仅供你接续写作，不要复述。',
  en: '[Story so far] A summary of earlier events, for continuity only. Do not retell it.',
}

/** The prepared conversation, as the assembler consumes it. */
export interface NovelHistory {
  /** Text of the conversation's own system messages. */
  systemPrompt: string
  /** User and assistant turns with text, oldest first. */
  turns: NovelTurn[]
}

/**
 * Read a prepared prompt (what the normal pipeline built) into system text and
 * turns. Messages are not changed. A message without text, such as an image-only
 * one, is not a turn: it is never dropped and costs nothing here.
 */
export function splitNovelHistory(messages: readonly Message[]): NovelHistory {
  const systemParts: string[] = []
  const turns: NovelTurn[] = []
  for (const message of messages) {
    const text = getMessageText(message, false, false).trim()
    if (!text) continue
    if (message.role === 'system') systemParts.push(text)
    else if (message.role === 'user' || message.role === 'assistant')
      turns.push({ id: message.id, role: message.role, text })
  }
  return { systemPrompt: systemParts.join('\n\n'), turns }
}

function textMessage(id: string, role: Message['role'], text: string): Message {
  return { id, role, contentParts: [{ type: 'text', text }] }
}

/**
 * Apply an assembly to a prepared prompt: remove the turns that left the verbatim
 * window and add the story so far ahead of the rest. With nothing to change the
 * same array comes back, so the request stays exactly what the normal pipeline built.
 */
export function applyNovelHistory(
  messages: Message[],
  history: NovelHistory,
  assembly: NovelAssembly,
  language: NovelPromptLanguage = 'zh'
): Message[] {
  const kept = new Set(assembly.manifest.keptTurnIds)
  const dropped = new Set(history.turns.filter((turn) => !kept.has(turn.id)).map((turn) => turn.id))
  const remaining = dropped.size > 0 ? messages.filter((message) => !dropped.has(message.id)) : messages

  const firstConversation = remaining.findIndex((message) => message.role !== 'system')
  const insertAt = firstConversation < 0 ? remaining.length : firstConversation
  let opening: Message | undefined
  if (assembly.storySoFar) {
    const text = `${STORY_SO_FAR_HEADING[language]}\n\n${assembly.storySoFar}`
    opening = textMessage('novel:story-so-far', 'user', text)
  } else if (dropped.size > 0 && remaining[insertAt]?.role === 'assistant') {
    // Chat templates may reject a conversation that opens with an assistant turn.
    opening = textMessage(
      'novel:history-start',
      'user',
      getContextHistoryStartNote(language === 'zh' ? 'zh-Hans' : 'en')
    )
  }
  if (!opening) return remaining
  return [...remaining.slice(0, insertAt), opening, ...remaining.slice(insertAt)]
}

/**
 * Put the per-turn context in front of the author's reply, so their words come
 * after it. Name the reply by id: the newest user-role message may instead be a
 * time-gap reminder the pipeline appended. It is added at send time and never
 * stored in the conversation.
 */
export function addNovelContext(messages: Message[], volatileBlock: string, replyMessageId?: string): Message[] {
  if (!volatileBlock) return messages
  const named = replyMessageId ? messages.findLastIndex((message) => message.id === replyMessageId) : -1
  const index = named >= 0 ? named : messages.findLastIndex((message) => message.role === 'user')
  if (index < 0) return messages
  const target = messages[index]
  const updated = [...messages]
  updated[index] = { ...target, contentParts: [{ type: 'text', text: volatileBlock }, ...target.contentParts] }
  return updated
}
