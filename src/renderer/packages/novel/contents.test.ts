import type { SessionContextRepositoryPort, SessionMessageRepositoryPort } from '@chatbox/core/ports'
import type { Message } from '@shared/types'
import { describe, expect, it, vi } from 'vitest'
import { createNovelContentsReader } from './contents'

const message = (id: string, role: Message['role'], text: string): Message => ({
  id,
  role,
  contentParts: [{ type: 'text', text }],
})

describe('novel contents', () => {
  it('follows the selected path, skips discussion, and refreshes edited chapter titles', async () => {
    let path = ['setup', 'first', 'discussion', 'second']
    const messages = new Map([
      ['setup', message('setup', 'user', '第一章这个标题怎么样？')],
      ['first', message('first', 'assistant', '# 序章 雾中的信\n\n正文')],
      ['discussion', message('discussion', 'assistant', '我们可以改一下人物的动机。')],
      ['second', message('second', 'assistant', '**第一章 归途**\n\n正文')],
      ['branch', message('branch', 'assistant', '第一章 另一条路\n\n正文')],
    ])
    const readSessionMessages = vi.fn(({ messageIds }: { messageIds: string[] }) =>
      Promise.resolve({
        messages: messageIds.map((id) => messages.get(id)),
      })
    )
    const source = {
      getSessionContextSource: () => Promise.resolve({ pathMessageIds: path, revision: 7 }),
      readSessionMessages,
    } as unknown as SessionContextRepositoryPort & SessionMessageRepositoryPort
    const reader = createNovelContentsReader(source)
    const signal = new AbortController().signal
    expect(await reader.read('novel', signal)).toEqual([
      { messageId: 'first', title: '序章 雾中的信' },
      { messageId: 'second', title: '第一章 归途' },
    ])
    await reader.read('novel', signal)
    expect(readSessionMessages).toHaveBeenCalledTimes(1)
    path = ['setup', 'first', 'branch']
    expect(await reader.read('novel', signal)).toEqual([
      { messageId: 'first', title: '序章 雾中的信' },
      { messageId: 'branch', title: '第一章 另一条路' },
    ])
    messages.set('first', message('first', 'assistant', '序章 新的信'))
    reader.invalidate(['first'])
    expect((await reader.read('novel', signal))[0].title).toBe('序章 新的信')
    expect(readSessionMessages).toHaveBeenLastCalledWith({
      sessionId: 'novel',
      messageIds: ['first'],
      expectedRevision: 7,
    })
  })

  it('does not publish a partial directory from a failed or cancelled scan', async () => {
    const source = {
      getSessionContextSource: () => Promise.resolve({ pathMessageIds: ['missing'], revision: 7 }),
      readSessionMessages: () => Promise.resolve({ messages: [] }),
    } as unknown as SessionContextRepositoryPort & SessionMessageRepositoryPort
    const reader = createNovelContentsReader(source)
    await expect(reader.read('novel', new AbortController().signal)).rejects.toThrow('Novel changed')
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(reader.read('novel', cancelled.signal)).rejects.toThrow()
  })
})
