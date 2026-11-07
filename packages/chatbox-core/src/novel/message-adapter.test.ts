import { describe, expect, it } from 'vitest'
import type { Message } from '../types'
import { assembleNovelContext } from './assemble'
import { resolveNovelBudget } from './budget'
import { addNovelContext, applyNovelHistory, splitNovelHistory } from './message-adapter'
import type { NovelAssemblyInput } from './types'

const count = (text: string) => text.length

function msg(id: string, role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { id, role, contentParts: [{ type: 'text', text }], ...extra }
}

const textOf = (message: Message) =>
  message.contentParts.map((part) => (part.type === 'text' ? part.text : `<${part.type}>`)).join('|')

/** m0 m1 m2 ... alternating user and assistant, each 100 characters; the last is the current reply. */
function longChat(messages: number): Message[] {
  return Array.from({ length: messages }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user', 'x'.repeat(100)))
}

function assemble(messages: Message[], overrides: Partial<NovelAssemblyInput> = {}) {
  const history = splitNovelHistory(messages)
  const assembly = assembleNovelContext({
    totalBudgetTokens: 5000,
    countTokens: count,
    systemPrompt: history.systemPrompt,
    lore: [],
    turns: history.turns,
    ...overrides,
  })
  return { history, assembly }
}

describe('splitNovelHistory', () => {
  it('separates system text from turns', () => {
    const history = splitNovelHistory([
      msg('s', 'system', '你是一位小说家。'),
      msg('u1', 'user', '继续。'),
      msg('a1', 'assistant', '她走过断桥。'),
      msg('u2', 'user', '选B。'),
    ])
    expect(history.systemPrompt).toBe('你是一位小说家。')
    expect(history.turns.map((turn) => [turn.id, turn.role])).toEqual([
      ['u1', 'user'],
      ['a1', 'assistant'],
      ['u2', 'user'],
    ])
  })

  it('ignores reasoning, empty messages and non-conversation roles', () => {
    const history = splitNovelHistory([
      {
        id: 'a1',
        role: 'assistant',
        contentParts: [
          { type: 'reasoning', text: '先想一想剧情走向' },
          { type: 'text', text: '正文。' },
        ],
      },
      msg('empty', 'user', '   '),
      msg('tool', 'tool', 'result'),
    ])
    expect(history.turns).toEqual([{ id: 'a1', role: 'assistant', text: '正文。' }])
  })

  it('joins several system messages', () => {
    expect(splitNovelHistory([msg('s1', 'system', 'A'), msg('s2', 'system', 'B')]).systemPrompt).toBe('A\n\nB')
  })
})

describe('applyNovelHistory', () => {
  it('returns the same array when there is nothing to change', () => {
    const messages = [msg('s', 'system', '你是小说家。'), msg('u1', 'user', '继续。')]
    const { history, assembly } = assemble(messages)
    expect(applyNovelHistory(messages, history, assembly)).toBe(messages)
  })

  it('removes the turns that left the window and nothing else', () => {
    const system = msg('s', 'system', '你是小说家。')
    const imageOnly: Message = { id: 'img', role: 'user', contentParts: [{ type: 'image', storageKey: 'k' }] }
    const messages = [system, imageOnly, ...longChat(61)]
    const { history, assembly } = assemble(messages, { coveredThroughTurnId: 'm59' })

    const applied = applyNovelHistory(messages, history, assembly)

    expect(assembly.manifest.droppedTurnCount).toBeGreaterThan(0)
    expect(applied[0]).toBe(system)
    expect(applied).toContain(imageOnly)
    expect(applied.at(-1)?.id).toBe('m60')
    expect(applied.map((m) => m.id)).not.toContain('m0')
  })

  it('leaves the original array alone', () => {
    const messages = longChat(61)
    const ids = messages.map((m) => m.id)
    const { history, assembly } = assemble(messages, { coveredThroughTurnId: 'm59' })
    applyNovelHistory(messages, history, assembly)
    expect(messages.map((m) => m.id)).toEqual(ids)
  })

  it('adds the story so far after the system text', () => {
    const messages = [msg('s', 'system', '你是小说家。'), msg('u1', 'user', '继续。')]
    const { history, assembly } = assemble(messages, { storySoFar: '艾琳离开了村子。' })

    const applied = applyNovelHistory(messages, history, assembly)

    expect(applied.map((m) => m.id)).toEqual(['s', 'novel:story-so-far', 'u1'])
    expect(textOf(applied[1])).toContain('【前情提要】')
    expect(textOf(applied[1])).toContain('艾琳离开了村子')
  })

  it('opens with a note when dropping leaves an assistant turn first and there is no story so far', () => {
    // 61 turns with odd indexes as users, so the window, which starts on an even index, opens on an assistant turn.
    const messages = Array.from({ length: 61 }, (_, i) => msg(`m${i}`, i % 2 ? 'user' : 'assistant', 'x'.repeat(100)))
    const { history, assembly } = assemble(messages, { coveredThroughTurnId: 'm59' })

    const applied = applyNovelHistory(messages, history, assembly)

    expect(applied[0]).toMatchObject({ id: 'novel:history-start', role: 'user' })
    expect(textOf(applied[0])).toContain('此前的部分对话未包含在内')
  })

  it('adds no note when nothing was dropped', () => {
    const messages = [msg('a1', 'assistant', '开场白。'), msg('u1', 'user', '继续。')]
    const { history, assembly } = assemble(messages)
    expect(applyNovelHistory(messages, history, assembly)).toBe(messages)
  })

  it('uses English wording when asked', () => {
    const messages = [msg('u1', 'user', 'Go on.')]
    const { history, assembly } = assemble(messages, { storySoFar: 'Eileen left the village.', language: 'en' })
    expect(textOf(applyNovelHistory(messages, history, assembly, 'en')[0])).toContain('[Story so far]')
  })
})

describe('addNovelContext', () => {
  it('returns the same array when there is nothing to add', () => {
    const messages = [msg('u1', 'user', '继续。')]
    expect(addNovelContext(messages, '')).toBe(messages)
  })

  it('puts the context in front of the newest user message, so the author speaks last', () => {
    const messages = [msg('u1', 'user', '开始。'), msg('a1', 'assistant', '好。'), msg('u2', 'user', '选B。')]
    const added = addNovelContext(messages, '<story_context>x</story_context>')
    expect(textOf(added[2])).toBe('<story_context>x</story_context>|选B。')
    expect(added[0]).toBe(messages[0])
    expect(added[1]).toBe(messages[1])
  })

  it('finds the named reply even when a reminder follows it', () => {
    const reply = msg('u2', 'user', '选B。')
    const reminder = msg('reminder', 'user', '<system-reminder>time passed</system-reminder>')
    const added = addNovelContext([msg('a1', 'assistant', '好。'), reply, reminder], 'context', 'u2')
    expect(textOf(added[1])).toBe('context|选B。')
    expect(added[2]).toBe(reminder)
  })

  it('falls back to the newest user message when the named reply is gone', () => {
    const added = addNovelContext([msg('u1', 'user', '选B。')], 'context', 'missing')
    expect(textOf(added[0])).toBe('context|选B。')
  })

  it('does not change the stored message', () => {
    const messages = [msg('u1', 'user', '选B。')]
    addNovelContext(messages, 'context')
    expect(textOf(messages[0])).toBe('选B。')
  })

  it('keeps attachments and images after the context', () => {
    const withImage: Message = {
      id: 'u1',
      role: 'user',
      contentParts: [
        { type: 'text', text: '看这张图。' },
        { type: 'image', storageKey: 'img-1' },
      ],
    }
    const added = addNovelContext([withImage], 'context')
    expect(added[0].contentParts.slice(1)).toEqual(withImage.contentParts)
  })

  it('adds nothing when no user message exists', () => {
    const messages = [msg('a1', 'assistant', '开场白。')]
    expect(addNovelContext(messages, 'context')).toBe(messages)
  })
})

describe('resolveNovelBudget', () => {
  it('uses the default when nothing valid is requested', () => {
    expect(resolveNovelBudget(undefined)).toBe(60_000)
    expect(resolveNovelBudget(0)).toBe(60_000)
    expect(resolveNovelBudget(Number.NaN)).toBe(60_000)
  })
  it('keeps the request when it fits the window', () => {
    expect(resolveNovelBudget(30_000, 100_000)).toBe(30_000)
  })
  it('clamps to 90% of the usable window', () => {
    expect(resolveNovelBudget(60_000, 40_000)).toBe(36_000)
    expect(resolveNovelBudget(undefined, 32_000)).toBe(28_800)
  })
  it('ignores an unknown or invalid window', () => {
    expect(resolveNovelBudget(50_000, null)).toBe(50_000)
    expect(resolveNovelBudget(50_000, 0)).toBe(50_000)
  })
})
