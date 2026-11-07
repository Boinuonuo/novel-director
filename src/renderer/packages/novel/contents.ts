import { hasChapterHeading } from '@chatbox/core/novel'
import type {
  SessionCommandDelta,
  SessionContextRepositoryPort,
  SessionMessageRepositoryPort,
} from '@chatbox/core/ports'
import type { Message } from '@shared/types'

export interface NovelChapterLink {
  messageId: string
  title: string
}

function chapterLink(message: Message): NovelChapterLink | null {
  if (message.role !== 'assistant' || message.error) return null
  // Read only the heading; joining/splitting an entire long chapter allocates its body again.
  for (const part of message.contentParts ?? []) {
    if (part.type !== 'text' || part.protocolOnly) continue
    let start = 0
    while (start < part.text.length) {
      const newline = part.text.indexOf('\n', start)
      const end = newline < 0 ? part.text.length : newline
      const firstLine = part.text.slice(start, Math.min(end, start + 240)).trim()
      if (firstLine)
        return hasChapterHeading(firstLine)
          ? {
              messageId: message.id,
              title: firstLine.replace(/^\s*#{1,6}\s*/, '').replace(/\*\*/g, ''),
            }
          : null
      if (newline < 0) break
      start = newline + 1
    }
  }
  return null
}

/** Retain titles only; fetch message bodies in bounded batches on the selected path. */
export function createNovelContentsReader(source: SessionContextRepositoryPort & SessionMessageRepositoryPort) {
  const titles = new Map<string, NovelChapterLink | null>()
  let knownPath: Set<string> | undefined
  let activeThreadId: string | undefined
  let lastContents: NovelChapterLink[] = []
  return {
    invalidate(ids: readonly string[]) {
      for (const id of ids) titles.delete(id)
    },
    /** Body-only stream commits carry the heading already; they need no directory/database read. */
    acceptDelta(delta: SessionCommandDelta): boolean {
      let changed =
        !knownPath ||
        Boolean(delta.structureResult) ||
        delta.diff.messages.delete.length > 0 ||
        delta.diff.threads.delete.length > 0 ||
        delta.record.activeThreadId !== activeThreadId
      for (const row of delta.diff.messages.upsert) {
        const previous = titles.get(row.messageId)
        const next = chapterLink(row.message)
        if (!knownPath?.has(row.messageId) || !titles.has(row.messageId) || previous?.title !== next?.title)
          changed = true
        titles.set(row.messageId, next)
      }
      for (const id of delta.diff.messages.delete) titles.delete(id)
      return changed
    },
    async read(sessionId: string, signal: AbortSignal): Promise<NovelChapterLink[]> {
      const context = await source.getSessionContextSource({ sessionId, maxContextMessageCount: 1 })
      signal.throwIfAborted()
      if (!context) throw new Error('Novel unavailable')
      const path = context.pathMessageIds
      const missing = path.filter((id) => !titles.has(id))
      for (let offset = 0; offset < missing.length; offset += 24) {
        signal.throwIfAborted()
        const ids = missing.slice(offset, offset + 24)
        const page = await source.readSessionMessages({
          sessionId,
          messageIds: ids,
          expectedRevision: context.revision ?? undefined,
        })
        signal.throwIfAborted()
        if (!page || page.messages.length !== ids.length) throw new Error('Novel changed while reading contents')
        for (const message of page.messages) titles.set(message.id, chapterLink(message))
      }
      const onPath = new Set(path)
      for (const id of titles.keys()) if (!onPath.has(id)) titles.delete(id)
      knownPath = onPath
      activeThreadId = context.thread?.threadId
      const contents = path.flatMap((id) => titles.get(id) ?? [])
      if (
        contents.length !== lastContents.length ||
        contents.some(
          (entry, index) =>
            entry.messageId !== lastContents[index].messageId || entry.title !== lastContents[index].title
        )
      )
        lastContents = contents
      return lastContents
    },
  }
}
