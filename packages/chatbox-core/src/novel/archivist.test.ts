import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../types'
import { hasChapterHeading, NovelArchivist, type NovelArchivistPorts } from './archivist'
import { assembleNovelContext } from './assemble'
import type { NovelRecord } from './chapter-record'
import { buildNovelSnapshot, foldNovelMemory } from './memory'
import { splitNovelHistory } from './message-adapter'

const msg = (id: string, role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role,
  contentParts: [{ type: 'text', text }],
  ...extra,
})

/** u1 a1 u2 a2 ..., each chapter's text naming its id so a scripted reply can quote it. */
function story(chapters: number): Message[] {
  return Array.from({ length: chapters }, (_, i) => [
    msg(`u${i + 1}`, 'user', `选A，第${i + 1}章`),
    msg(`a${i + 1}`, 'assistant', `第${i + 1}章正文。艾琳走进了雨里。`),
  ]).flat()
}

const textOf = (message: Message) => (message.contentParts[0] as { text: string }).text

const reply = (note: Record<string, unknown> = {}) =>
  JSON.stringify({
    summary: '艾琳继续前行。',
    inScene: ['艾琳'],
    characters: [],
    terms: [],
    hooksPlanted: [],
    hooksResolved: [],
    ...note,
  })

function harness(
  initial: Message[],
  { settleReplies, headings }: { settleReplies?: number; headings?: boolean } = { settleReplies: 0 }
) {
  const state = { messages: initial, records: [] as NovelRecord[], enabled: true }
  const complete = vi.fn(async (_prompt: string, _role?: string) => ({ text: reply(), model: 'aux' }))
  const ports: NovelArchivistPorts = {
    isEnabled: async () => state.enabled,
    readPath: async () => state.messages.map((message) => message.id),
    readMessages: async (_sessionId, ids) => state.messages.filter((message) => ids.includes(message.id)),
    listRecords: async () => state.records,
    putRecord: async (_sessionId, record) => {
      state.records = [...state.records.filter((item) => item.id !== record.id), record]
    },
    deleteRecord: async (_sessionId, recordId) => {
      state.records = state.records.filter((item) => item.id !== recordId)
    },
    complete,
    schedule: (run) => run(),
    now: () => 1,
    logError: vi.fn(),
    settleReplies,
    chapterHeadings: async () => headings === true,
  }
  const archivist = new NovelArchivist(ports)
  const memory = () =>
    foldNovelMemory(
      state.records,
      state.messages.map((message) => message.id)
    )
  return { state, complete, archivist, memory }
}

describe('NovelArchivist', () => {
  let session: ReturnType<typeof harness>
  beforeEach(() => {
    session = harness(story(3))
  })

  it('records every finished chapter, oldest first, so a session turned on mid-way fills itself in', async () => {
    await session.archivist.run('s')
    const memory = session.memory()
    expect(memory.chapters.map((chapter) => chapter.messageId)).toEqual(['a1', 'a2', 'a3'])
    expect(memory.coveredThroughMessageId).toBe('a3')
    expect(session.archivist.getStatus('s')).toMatchObject({ state: 'idle', chapters: 3 })
  })

  it('does nothing when long-form support is off', async () => {
    session.state.enabled = false
    await session.archivist.run('s')
    expect(session.complete).not.toHaveBeenCalled()
  })

  it('waits for a chapter that is still being written', async () => {
    session.state.messages = [
      ...story(1),
      msg('u2', 'user', '继续'),
      msg('a2', 'assistant', '写到一半', { generating: true }),
    ]
    await session.archivist.run('s')
    expect(session.memory().chapters.map((chapter) => chapter.messageId)).toEqual(['a1'])
  })

  it('leaves a failed reply out', async () => {
    session.state.messages = [
      ...story(1),
      msg('u2', 'user', '继续'),
      msg('a2', 'assistant', '半截', { error: 'network' }),
    ]
    await session.archivist.run('s')
    expect(session.memory().chapters.map((chapter) => chapter.messageId)).toEqual(['a1'])
  })

  it('counts the last of several alternative replies as the chapter', async () => {
    session.state.messages = [
      msg('u1', 'user', '开始'),
      msg('alt', 'assistant', '另一版。'),
      msg('a1', 'assistant', '采用的一版。'),
      msg('u2', 'user', '继续'),
    ]
    await session.archivist.run('s')
    const [chapter] = session.memory().chapters
    expect(chapter.messageId).toBe('a1')
    expect(chapter.covers).toEqual(['u1', 'alt', 'a1'])
    expect(session.memory().coveredThroughMessageId).toBe('a1')
  })

  it('rewinds by itself when a chapter is regenerated, then records the new one', async () => {
    await session.archivist.run('s')
    session.state.messages = [...story(2), msg('u3', 'user', '选A，第3章'), msg('a3-new', 'assistant', '新的第三章。')]

    expect(session.memory().chapters.map((chapter) => chapter.messageId)).toEqual(['a1', 'a2'])

    await session.archivist.run('s')
    expect(session.memory().chapters.map((chapter) => chapter.messageId)).toEqual(['a1', 'a2', 'a3-new'])
    expect(session.memory().chapters.at(-1)?.covers).toEqual(['u3', 'a3-new'])
  })

  it('stops at the first unrecorded chapter, so a gap can never be skipped over', async () => {
    await session.archivist.run('s')
    session.state.records = session.state.records.filter((record) => record.id !== 'a2')

    expect(session.memory().chapters.map((chapter) => chapter.messageId)).toEqual(['a1'])
    expect(session.memory().coveredThroughMessageId).toBe('a1')

    await session.archivist.run('s')
    expect(session.memory().chapters.map((chapter) => chapter.messageId)).toEqual(['a1', 'a2', 'a3'])
  })

  it('retries once on a malformed reply', async () => {
    session.state.messages = story(1)
    session.complete.mockResolvedValueOnce({ text: 'not json', model: 'aux' })
    await session.archivist.run('s')
    expect(session.complete).toHaveBeenCalledTimes(2)
    expect(session.memory().chapters).toHaveLength(1)
  })

  it('stops without writing on repeated failure, and resumes at the same chapter later', async () => {
    session.complete.mockResolvedValue({ text: 'still not json', model: 'aux' })
    await session.archivist.run('s')
    expect(session.state.records).toEqual([])
    expect(session.archivist.getStatus('s').state).toBe('failed')

    session.complete.mockResolvedValue({ text: reply(), model: 'aux' })
    await session.archivist.run('s')
    expect(session.memory().chapters).toHaveLength(3)
    expect(session.archivist.getStatus('s').state).toBe('idle')
  })

  it('survives the model call throwing', async () => {
    session.complete.mockRejectedValue(new Error('rate limited'))
    await expect(session.archivist.run('s')).resolves.toBeUndefined()
    expect(session.archivist.getStatus('s')).toMatchObject({ state: 'failed', error: 'rate limited' })
  })

  it('merges a request that arrives during a pass into one more pass', async () => {
    session.state.messages = story(1)
    session.complete.mockImplementationOnce(async () => {
      session.state.messages = story(2)
      session.archivist.schedule('s')
      return { text: reply(), model: 'aux' }
    })
    await session.archivist.run('s')
    expect(session.memory().chapters).toHaveLength(2)
  })

  it('tells the model what it already knows and which foreshadowing is open', async () => {
    session.state.messages = story(2)
    session.complete.mockResolvedValueOnce({
      text: reply({
        characters: [{ name: '艾琳', traits: ['寡言'], evidence: '艾琳走进了雨里' }],
        hooksPlanted: [{ text: '雨里有东西', evidence: '艾琳走进了雨里' }],
      }),
      model: 'aux',
    })
    await session.archivist.run('s')
    const prompt = session.complete.mock.calls[1][0]
    expect(prompt).toContain('- 艾琳：性格 寡言')
    expect(prompt).toContain('h1：雨里有东西')
    expect(prompt).toContain('上一章概要：艾琳继续前行。')
  })

  it('closes foreshadowing the model reports as paid off', async () => {
    session.state.messages = story(2)
    session.complete
      .mockResolvedValueOnce({
        text: reply({ hooksPlanted: [{ text: '雨里有东西', evidence: '艾琳走进了雨里' }] }),
        model: 'aux',
      })
      .mockResolvedValueOnce({ text: reply({ hooksResolved: ['h1', 'h9'] }), model: 'aux' })
    await session.archivist.run('s')
    expect(session.memory().openHooks).toEqual([])
  })

  it('never lets a choice the author did not take into memory', async () => {
    const chapter = '艾琳走到桥头，停下了脚步。\n\n接下来：\nA. 艾琳拔出霜牙\nB. 艾琳转身离开\nC. 艾琳开口询问'
    session.state.messages = [msg('u1', 'user', '开始'), msg('a1', 'assistant', chapter), msg('u2', 'user', '选C')]
    session.complete.mockResolvedValueOnce({
      text: reply({
        hooksPlanted: [
          { text: '她拔了剑', evidence: '艾琳拔出霜牙' },
          { text: '她停在桥头', evidence: '艾琳走到桥头' },
        ],
      }),
      model: 'aux',
    })
    await session.archivist.run('s')

    expect(session.complete.mock.calls[0][0]).not.toContain('艾琳拔出霜牙')
    expect(session.memory().openHooks.map((hook) => hook.text)).toEqual(['她停在桥头'])
  })

  it('condenses old stretches into one paragraph once enough newer chapters follow', async () => {
    session.state.messages = story(20)
    session.complete.mockImplementation(async (prompt: string) =>
      prompt.includes('阶段总结') ? { text: '前十章的总结。', model: 'aux' } : { text: reply(), model: 'aux' }
    )
    await session.archivist.run('s')

    const { segments } = session.memory()
    expect(segments[0]).toMatchObject({ throughTurnId: 'a10', text: '第1至10章：前十章的总结。' })
    expect(segments).toHaveLength(11)
  })

  it('ignores a summary of a stretch that a regenerated chapter broke', async () => {
    session.state.messages = story(20)
    session.complete.mockImplementation(async (prompt: string) =>
      prompt.includes('阶段总结') ? { text: '前十章的总结。', model: 'aux' } : { text: reply(), model: 'aux' }
    )
    await session.archivist.run('s')
    session.state.messages = story(4)
    expect(session.memory().segments).toHaveLength(4)
    expect(session.memory().segments[0].text).toMatch(/^第1章/)
  })
})

describe('talk before and between chapters', () => {
  const talk = [
    msg('u1', 'user', '我想写个武侠故事'),
    msg('a1', 'assistant', '想要什么风格？主角是谁？'),
    msg('u2', 'user', '冷峻一点，主角叫沈砚，是个刀客'),
    msg('a2', 'assistant', '好，设定够了，可以开写了。'),
    msg('u3', 'user', '开始吧'),
    msg('a3', 'assistant', '序章 雨夜\n\n沈砚走进了雨里。\n\n接下来：\nA. 去渡口\nB. 回客栈'),
    msg('u4', 'user', '去渡口'),
    msg('a4', 'assistant', '第一章 渡口\n\n沈砚到了渡口。'),
    msg('u5', 'user', '继续'),
  ]

  it('starts at the prologue, and leaves the talk before it out of the chapters', async () => {
    const session = harness(talk, { headings: true, settleReplies: 0 })
    await session.archivist.run('s')
    expect(session.memory().chapters.map((chapter) => chapter.messageId)).toEqual(['a3', 'a4'])
    expect(session.memory().chapters[0].covers).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
  })

  it('shows the model the talk, and records what it settled', async () => {
    const session = harness(talk, { headings: true, settleReplies: 0 })
    session.complete.mockResolvedValueOnce({
      text: reply({ characters: [{ name: '沈砚', traits: ['冷峻'], evidence: '主角叫沈砚，是个刀客' }] }),
      model: 'aux',
    })
    await session.archivist.run('s')
    const prompt = session.complete.mock.calls[0][0]
    expect(prompt).toContain('本章之前的讨论')
    expect(prompt).toContain('作者：冷峻一点，主角叫沈砚，是个刀客')
    expect(prompt).toContain('你：好，设定够了，可以开写了。')
    expect(session.memory().characters.map((item) => item.name)).toEqual(['沈砚'])
  })

  it('keeps discussion out of the chapter text, so a quote from it has to come from the talk', async () => {
    const session = harness(talk, { headings: true, settleReplies: 0 })
    session.complete.mockResolvedValueOnce({
      text: reply({ terms: [{ name: '无中生有', description: '没有出处', evidence: '书里没有这句话' }] }),
      model: 'aux',
    })
    await session.archivist.run('s')
    expect(session.memory().terms).toEqual([])
  })

  it('calls talk after a chapter discussion, not a chapter', async () => {
    const messages = [
      msg('u1', 'user', '开始'),
      msg('a1', 'assistant', '序章 雨夜\n\n沈砚走进了雨里。'),
      msg('u2', 'user', '先停一下，复盘一下前面'),
      msg('a2', 'assistant', '好的，目前沈砚还没有同伴。'),
      msg('u3', 'user', '继续'),
      msg('a3', 'assistant', '第一章 渡口\n\n沈砚到了渡口。'),
      msg('u4', 'user', '继续'),
    ]
    const session = harness(messages, { headings: true, settleReplies: 2 })
    await session.archivist.run('s')
    expect(session.complete.mock.calls[0][0]).toContain('后续讨论：好的，目前沈砚还没有同伴。')
    expect(session.memory().chapters.map((chapter) => chapter.messageId)).toEqual(['a1'])
  })

  it('treats every reply as a chapter in a story that does not mark them', async () => {
    const session = harness(talk)
    await session.archivist.run('s')
    expect(session.memory().chapters.map((chapter) => chapter.messageId)).toEqual(['a1', 'a2', 'a3', 'a4'])
  })

  it('gives up waiting for a heading a story never writes', async () => {
    const plain = Array.from({ length: 10 }, (_, index) => [
      msg(`u${index}`, 'user', '继续'),
      msg(`a${index}`, 'assistant', '她走进了雨里。'),
    ]).flat()
    const session = harness(plain, { headings: true, settleReplies: 0 })
    await session.archivist.run('s')
    expect(session.memory().chapters.length).toBeGreaterThan(0)
  })

  it('does not record anything while the first talk is still going on', async () => {
    const session = harness(talk.slice(0, 4), { headings: true, settleReplies: 0 })
    await session.archivist.run('s')
    expect(session.complete).not.toHaveBeenCalled()
  })
})

describe('hasChapterHeading', () => {
  it.each(['序章 雨夜\n正文', '第一章 渡口', '## 第十二章：夜行', '**第3章** 回家', '\n\n楔子\n正文', '第 二十 章'])(
    'recognises %j',
    (text) => expect(hasChapterHeading(text)).toBe(true)
  )

  it.each(['好的，这一章你想怎么写？', '我们先聊聊设定', '她说：第一章已经写完了。', ''])(
    'does not mistake %j for one',
    (text) => expect(hasChapterHeading(text)).toBe(false)
  )
})

describe('waiting for a chapter to settle', () => {
  it('records a chapter only after two later replies', async () => {
    const session = harness(story(2), {})
    await session.archivist.run('s')
    expect(session.complete).not.toHaveBeenCalled()

    session.state.messages = [...story(2), msg('u3', 'user', '选B，第3章')]
    await session.archivist.run('s')
    expect(session.memory().chapters.map((chapter) => chapter.messageId)).toEqual(['a1'])
    expect(session.memory().coveredThroughMessageId).toBe('a1')
  })

  it('shows the model the replies and chapters that followed, without their options', async () => {
    const messages = story(3)
    messages[3] = msg('a2', 'assistant', '第2章正文。\n\n接下来：\nA. 拔剑\nB. 离开\nC. 询问')
    const session = harness(messages, {})
    await session.archivist.run('s')

    const prompt = session.complete.mock.calls[0][0]
    const followUps = prompt.slice(prompt.indexOf('后续发展（'))
    expect(followUps).toContain('作者回复：选A，第2章')
    expect(followUps).toContain('后续章节：第2章正文。')
    expect(followUps).toContain('作者回复：选A，第3章')
    expect(followUps).toContain('后续章节：第3章正文。')
    expect(followUps).not.toContain('拔剑')
  })

  it('counts replies before a chapter still being written, and judges without that chapter', async () => {
    const messages = [
      ...story(2),
      msg('u3', 'user', '第3章不要这样写'),
      msg('a3', 'assistant', '写到一半', { generating: true }),
    ]
    const session = harness(messages, {})
    await session.archivist.run('s')

    expect(session.memory().chapters.map((chapter) => chapter.messageId)).toEqual(['a1'])
    expect(session.complete.mock.calls[0][0]).toContain('作者回复：第3章不要这样写')
    expect(session.complete.mock.calls[0][0]).not.toContain('写到一半')
  })

  it('accepts evidence from what the author wrote afterwards', async () => {
    const session = harness([...story(2), msg('u3', 'user', '把钥匙改成银色的')], {})
    session.complete.mockResolvedValueOnce({
      text: reply({ hooksPlanted: [{ text: '银色钥匙', evidence: '把钥匙改成银色的' }] }),
      model: 'aux',
    })
    await session.archivist.run('s')
    expect(session.memory().openHooks.map((hook) => hook.text)).toEqual(['银色钥匙'])
  })

  it('accepts evidence from the reply that led to the chapter', async () => {
    const session = harness(
      [msg('u1', 'user', '把钥匙改成银色的'), ...story(2).slice(1), msg('u3', 'user', '继续')],
      {}
    )
    session.complete.mockResolvedValueOnce({
      text: reply({ hooksPlanted: [{ text: '银色钥匙', evidence: '把钥匙改成银色的' }] }),
      model: 'aux',
    })
    await session.archivist.run('s')
    expect(session.memory().openHooks.map((hook) => hook.text)).toEqual(['银色钥匙'])
  })

  it('leaves a chapter the author rejected out of the story, and keeps the numbering', async () => {
    const session = harness(story(4), {})
    session.complete.mockResolvedValueOnce({ text: reply({ inScene: ['艾琳'] }), model: 'aux' }).mockResolvedValueOnce({
      text: reply({
        summary: '',
        superseded: true,
        inScene: ['幽灵'],
        characters: [{ name: '幽灵', evidence: '艾琳走进了雨里' }],
        hooksPlanted: [{ text: '被否掉的设定', evidence: '艾琳走进了雨里' }],
      }),
      model: 'aux',
    })
    await session.archivist.run('s')

    const memory = session.memory()
    expect(memory.coveredThroughMessageId).toBe('a2')
    expect(memory.chapters).toHaveLength(2)
    expect(memory.segments.map((segment) => segment.text)).toEqual(['第1章：艾琳继续前行。'])
    expect(memory.characters).toEqual([])
    expect(memory.openHooks).toEqual([])
    expect(memory.inScene).toEqual(['艾琳'])
  })
})

describe('corrections from the background', () => {
  const hook = { hooksPlanted: [{ text: '雨里有东西', evidence: '艾琳走进了雨里' }] }
  const drop = (extra: Record<string, unknown> = {}) => ({
    amendments: [
      { target: 'hook', ref: 'h1', action: 'drop', reason: '作者放弃了这条线', evidence: '艾琳走进了雨里', ...extra },
    ],
  })

  it('drops a record when the text supports it, and says why', async () => {
    const session = harness(story(2))
    session.complete
      .mockResolvedValueOnce({ text: reply(hook), model: 'aux' })
      .mockResolvedValueOnce({ text: reply(drop()), model: 'aux' })
    await session.archivist.run('s')

    expect(session.memory().openHooks).toEqual([])
    expect(session.memory().changes).toEqual([
      { chapter: 2, label: '雨里有东西', action: 'drop', value: '', reason: '作者放弃了这条线' },
    ])
  })

  it('ignores a correction with no quote from the text', async () => {
    const session = harness(story(2))
    session.complete
      .mockResolvedValueOnce({ text: reply(hook), model: 'aux' })
      .mockResolvedValueOnce({ text: reply(drop({ evidence: '书里没有这句话' })), model: 'aux' })
    await session.archivist.run('s')
    expect(session.memory().openHooks).toHaveLength(1)
  })

  it('ignores a rewrite that says nothing', async () => {
    const session = harness(story(2))
    session.complete
      .mockResolvedValueOnce({ text: reply(hook), model: 'aux' })
      .mockResolvedValueOnce({ text: reply(drop({ action: 'amend' })), model: 'aux' })
    await session.archivist.run('s')
    expect(session.memory().openHooks.map((item) => item.text)).toEqual(['雨里有东西'])
  })

  it('undoes a correction with the chapter that made it', async () => {
    const session = harness(story(2))
    session.complete
      .mockResolvedValueOnce({ text: reply(hook), model: 'aux' })
      .mockResolvedValueOnce({ text: reply(drop()), model: 'aux' })
    await session.archivist.run('s')

    session.state.messages = [...story(1), msg('u2', 'user', '选A，第2章'), msg('a2-new', 'assistant', '新的一章。')]
    expect(session.memory().openHooks.map((item) => item.text)).toEqual(['雨里有东西'])
    expect(session.memory().changes).toEqual([])
  })

  it('tells the model what the author deleted', async () => {
    const session = harness(story(2))
    session.state.records = [
      {
        kind: 'edit',
        id: 'edit:term:霜牙',
        target: 'term',
        key: '霜牙',
        action: 'delete',
        atChapter: 0,
        createdAt: 1,
      },
    ]
    await session.archivist.run('s')
    expect(session.complete.mock.calls[0][0]).toMatch(/作者已删除、不要再记的内容：\n- 霜牙/)
  })

  it('redoes a paragraph from the summary the author edited', async () => {
    const session = harness(story(20))
    session.complete.mockImplementation(async (prompt: string) =>
      prompt.includes('阶段总结') ? { text: '前十章的总结。', model: 'aux' } : { text: reply(), model: 'aux' }
    )
    await session.archivist.run('s')
    session.state.records = [
      ...session.state.records,
      {
        kind: 'edit',
        id: 'edit:chapter:a3',
        target: 'chapter',
        key: 'a3',
        action: 'update',
        patch: { text: '作者改过的概要' },
        atChapter: 20,
        createdAt: 2,
      },
    ]
    expect(session.memory().segments[2].text).toBe('第3章：作者改过的概要')

    session.complete.mockClear()
    await session.archivist.run('s')
    expect(session.complete).toHaveBeenCalledTimes(1)
    expect(session.complete.mock.calls[0][0]).toContain('作者改过的概要')
  })
})

describe('keeping the numbers', () => {
  const fact = (fields: Record<string, unknown>) => ({
    kind: 'state',
    owner: '艾琳',
    name: '钱袋',
    change: '',
    stated: true,
    evidence: '艾琳走进了雨里',
    ...fields,
  })
  const money = (value: string, fields: Record<string, unknown> = {}) => reply({ facts: [fact({ value, ...fields })] })

  it('asks for numbers, and shows the model what it has so far', async () => {
    const session = harness(story(2))
    session.complete.mockResolvedValueOnce({ text: money('37铜'), model: 'aux' })
    await session.archivist.run('s')

    expect(session.complete.mock.calls[0][0]).toContain('对数字和档次保持敏感')
    expect(session.complete.mock.calls[1][0]).toContain('f1：艾琳 / 钱袋 = 37铜')
  })

  it('corrects the sum of a value worked out from a change', async () => {
    const session = harness(story(2))
    session.complete
      .mockResolvedValueOnce({ text: money('37铜'), model: 'aux' })
      .mockResolvedValueOnce({ text: money('26铜', { change: '-12铜', stated: false }), model: 'aux' })
    await session.archivist.run('s')
    expect(session.memory().facts[0].value).toBe('25铜')
  })

  it('keeps the sum when the prose states a balance that does not add up, and says what the prose wrote', async () => {
    const session = harness(story(2))
    session.complete
      .mockResolvedValueOnce({ text: money('37铜'), model: 'aux' })
      .mockResolvedValueOnce({ text: money('26铜', { change: '-12铜', stated: true }), model: 'aux' })
    await session.archivist.run('s')
    const memory = session.memory()
    expect(memory.facts[0].value).toBe('25铜')
    expect(memory.changes[0]).toMatchObject({ label: '艾琳 钱袋', value: '25铜' })
    expect(memory.changes[0].reason).toContain('26铜')
  })

  it('takes the prose at its word when it states an amount with no change', async () => {
    const session = harness(story(2))
    session.complete
      .mockResolvedValueOnce({ text: money('37铜'), model: 'aux' })
      .mockResolvedValueOnce({ text: money('26铜'), model: 'aux' })
    await session.archivist.run('s')
    expect(session.memory().facts[0].value).toBe('26铜')
    expect(session.memory().changes).toEqual([])
  })

  it('uses a rate the story stated, even in the same chapter', async () => {
    const session = harness(story(2))
    const rate = fact({ kind: 'anchor', owner: '', name: '汇率', value: '1银=100铜' })
    session.complete.mockResolvedValueOnce({ text: money('8银9铜'), model: 'aux' }).mockResolvedValueOnce({
      text: reply({ facts: [rate, fact({ value: '错', change: '-12铜', stated: false })] }),
      model: 'aux',
    })
    await session.archivist.run('s')
    expect(session.memory().facts.find((item) => item.name === '钱袋')?.value).toBe('7银97铜')
  })

  it('needs a quote from the text', async () => {
    const session = harness(story(1))
    session.complete.mockResolvedValueOnce({ text: money('37铜', { evidence: '书里没有' }), model: 'aux' })
    await session.archivist.run('s')
    expect(session.memory().facts).toEqual([])
  })

  it('records nothing from a chapter the author rejected', async () => {
    const session = harness(story(1))
    session.complete.mockResolvedValueOnce({
      text: reply({ summary: '', superseded: true, facts: [fact({ value: '37铜' })] }),
      model: 'aux',
    })
    await session.archivist.run('s')
    expect(session.memory().facts).toEqual([])
  })

  it('corrects a number through an amendment by its label', async () => {
    const session = harness(story(2))
    session.complete.mockResolvedValueOnce({ text: money('37铜'), model: 'aux' }).mockResolvedValueOnce({
      text: reply({
        amendments: [
          { target: 'fact', ref: 'f1', action: 'amend', value: '30铜', reason: '算错了', evidence: '艾琳走进了雨里' },
        ],
      }),
      model: 'aux',
    })
    await session.archivist.run('s')
    expect(session.memory().facts[0].value).toBe('30铜')
  })

  describe('the world pass', () => {
    const worldReply = (body: Record<string, unknown>) => JSON.stringify({ facts: [], amendments: [], ...body })
    const wage = (fields: Record<string, unknown> = {}) => ({
      kind: 'anchor',
      name: '日薪',
      value: '约30铜',
      basis: '通铺一晚十二铜',
      ...fields,
    })
    const isWorld = (call: unknown[]) => call[1] === 'world'

    /** Scripts the chapter replies, then answers the world pass with `world`. */
    function scripted(session: ReturnType<typeof harness>, chapters: string[], world: string[] = []) {
      const replies = [...chapters]
      const answers = [...world]
      session.complete.mockImplementation(async (_prompt: string, role?: string) => ({
        text: role === 'world' ? (answers.shift() ?? worldReply({})) : (replies.shift() ?? reply()),
        model: role === 'world' ? 'thinker' : 'aux',
      }))
    }

    it('keeps the chapter pass to recording, so it never reasons about the world', async () => {
      const session = harness(story(1))
      await session.archivist.run('s')
      expect(session.complete.mock.calls[0][0]).not.toContain('世界观维护者')
      expect(session.complete.mock.calls[0][1]).toBeUndefined()
    })

    it('ignores an inference slipped into a chapter reply', async () => {
      const session = harness(story(1))
      session.complete.mockResolvedValueOnce({
        text: reply({ facts: [fact({ value: '约30铜', evidence: '', inferred: true, basis: '猜的' })] }),
        model: 'aux',
      })
      await session.archivist.run('s')
      expect(session.memory().facts).toEqual([])
    })

    it('waits for a few chapters after new numbers, then thinks with the world role', async () => {
      const session = harness(story(3))
      scripted(session, [money('37铜')], [worldReply({ facts: [wage()] })])
      await session.archivist.run('s')

      expect(session.complete.mock.calls.filter(isWorld)).toHaveLength(1)
      expect(session.complete.mock.calls.findLast(isWorld)?.[0]).toContain('世界观维护者')
      expect(session.memory().facts.find((item) => item.name === '日薪')).toMatchObject({
        inferred: true,
        basis: '通铺一晚十二铜',
        chapter: 3,
      })
      expect(session.memory().worldChapter).toBe(3)
    })

    it('catches up on a long session with one pass over the whole ledger', async () => {
      const session = harness(story(13))
      scripted(session, [money('37铜')])
      await session.archivist.run('s')
      expect(session.complete.mock.calls.filter(isWorld)).toHaveLength(1)
      expect(session.memory().worldChapter).toBe(13)
    })

    it('does not run before there is anything to think about', async () => {
      const session = harness(story(12))
      await session.archivist.run('s')
      expect(session.complete.mock.calls.filter(isWorld)).toEqual([])
    })

    it('checks in every so often even when no number is new', async () => {
      const session = harness(story(3))
      scripted(session, [money('37铜')])
      await session.archivist.run('s')

      session.state.messages = story(12)
      await session.archivist.run('s')
      expect(session.complete.mock.calls.filter(isWorld)).toHaveLength(1)

      session.state.messages = story(13)
      await session.archivist.run('s')
      expect(session.complete.mock.calls.filter(isWorld)).toHaveLength(2)
    })

    it('needs a basis for each inference, and limits how many one pass can add', async () => {
      const session = harness(story(3))
      const many = Array.from({ length: 12 }, (_, index) => wage({ name: `推定${index}` }))
      scripted(session, [money('37铜')], [worldReply({ facts: [wage({ name: '无依据', basis: '' }), ...many] })])
      await session.archivist.run('s')
      const inferred = session.memory().facts.filter((item) => item.inferred)
      expect(inferred).toHaveLength(8)
      expect(inferred.map((item) => item.name)).not.toContain('无依据')
    })

    it('does not let an inference replace what the prose said', async () => {
      const session = harness(story(3))
      const stated = reply({ facts: [fact({ kind: 'anchor', owner: '', name: '日薪', value: '50铜' })] })
      scripted(session, [stated], [worldReply({ facts: [wage()] })])
      await session.archivist.run('s')
      expect(session.memory().facts[0]).toMatchObject({ value: '50铜', inferred: false })
    })

    it('revises its own inference, but cannot touch a recorded value', async () => {
      const session = harness(story(3))
      const amend = (ref: string) => ({ target: 'fact', ref, action: 'amend', value: '改过', reason: '不自洽' })
      scripted(
        session,
        [money('37铜'), reply(), reply(), money('40铜')],
        [worldReply({ facts: [wage()] }), worldReply({ amendments: [amend('f1'), amend('f2')] })]
      )
      await session.archivist.run('s')
      session.state.messages = story(6)
      await session.archivist.run('s')
      expect(session.memory().facts.map((item) => item.value)).toEqual(['40铜', '改过'])
    })

    it('rewinds with the chapter it was attached to', async () => {
      const session = harness(story(3))
      scripted(session, [money('37铜')], [worldReply({ facts: [wage()] })])
      await session.archivist.run('s')

      session.state.messages = [...story(2), msg('u3', 'user', '选A，第3章'), msg('a3-new', 'assistant', '新的一章。')]
      expect(session.memory().facts.map((item) => item.name)).toEqual(['钱袋'])
      expect(session.memory().worldChapter).toBe(0)
    })

    it('stops on a bad reply without losing the chapters', async () => {
      const session = harness(story(3))
      scripted(session, [money('37铜')], ['not json', 'still not json'])
      await session.archivist.run('s')
      expect(session.archivist.getStatus('s').state).toBe('failed')
      expect(session.memory().chapters).toHaveLength(3)
    })
  })

  describe('older chapters', () => {
    async function recordedWithoutNumbers() {
      const session = harness(story(3))
      await session.archivist.run('s')
      session.state.records = session.state.records.map((record) => {
        if (record.kind !== 'chapter') return record
        const { facts: _facts, ...note } = record.note
        return { ...record, note }
      })
      session.complete.mockClear()
      return session
    }

    it('reads them only on request', async () => {
      const session = await recordedWithoutNumbers()
      await session.archivist.run('s')
      expect(session.complete).not.toHaveBeenCalled()
      expect(session.memory().unscannedChapters).toBe(3)
    })

    it('goes oldest first and carries each total into the next', async () => {
      const session = await recordedWithoutNumbers()
      session.complete
        .mockResolvedValueOnce({ text: JSON.stringify({ facts: [fact({ value: '37铜' })] }), model: 'aux' })
        .mockResolvedValueOnce({
          text: JSON.stringify({ facts: [fact({ value: '错', change: '-12铜', stated: false })] }),
          model: 'aux',
        })
        .mockResolvedValueOnce({ text: JSON.stringify({ facts: [] }), model: 'aux' })

      session.archivist.scanForFacts('s')
      await vi.waitFor(() => expect(session.memory().unscannedChapters).toBe(0))

      expect(session.complete.mock.calls[1][0]).toContain('f1：艾琳 / 钱袋 = 37铜')
      expect(session.memory().facts[0].value).toBe('25铜')
      expect(session.memory().unscannedChapters).toBe(0)
      expect(session.memory().chapters).toHaveLength(3)
    })

    it('stops on a bad reply and resumes from the same chapter', async () => {
      const session = await recordedWithoutNumbers()
      session.complete.mockResolvedValue({ text: 'not json', model: 'aux' })
      session.archivist.scanForFacts('s')
      await vi.waitFor(() => expect(session.archivist.getStatus('s').state).toBe('failed'))
      expect(session.memory().unscannedChapters).toBe(3)

      session.complete.mockResolvedValue({ text: JSON.stringify({ facts: [] }), model: 'aux' })
      await session.archivist.run('s')
      expect(session.memory().unscannedChapters).toBe(0)
    })
  })
})

describe('numbers of chapters not yet settled', () => {
  const FACTS_PROMPT = '只从下面这一章里整理可量化的账目'
  const note = (fields: Record<string, unknown>) => ({
    kind: 'state',
    owner: '艾琳',
    name: '钱袋',
    change: '',
    stated: false,
    evidence: '艾琳走进了雨里',
    ...fields,
  })
  const factsReply = (...facts: Record<string, unknown>[]) => JSON.stringify({ facts })

  /** a1 settles with 37铜; a2 spends 12 and a3 earns 5, read at once by the pending pass. */
  function session(chapterFacts: (prompt: string) => Record<string, unknown> = () => ({})) {
    const s = harness(story(3), { settleReplies: 2 })
    s.complete.mockImplementation(async (prompt: string) => {
      if (prompt.includes(FACTS_PROMPT)) {
        if (prompt.includes('第2章正文'))
          return { text: factsReply(note({ change: '-12铜', value: '25铜' })), model: 'aux' }
        if (prompt.includes('第3章正文'))
          return { text: factsReply(note({ change: '+5铜', value: '30铜' })), model: 'aux' }
        return { text: factsReply(), model: 'aux' }
      }
      const facts = prompt.includes('本章正文：\n第1章正文') ? [note({ value: '37铜', stated: true })] : []
      return { text: reply({ facts, ...chapterFacts(prompt) }), model: 'aux' }
    })
    const ledger = async () =>
      (
        await s.archivist.readLedger(
          's',
          s.state.messages.map((message) => message.id)
        )
      ).ledger
    const factCalls = () => s.complete.mock.calls.filter(([prompt]) => prompt.includes(FACTS_PROMPT)).length
    return { ...s, ledger, factCalls }
  }

  const reply3 = () => [msg('u4', 'user', '选B，第4章')]

  it('reads the newest chapters’ numbers at once, long before they settle', async () => {
    const s = session()
    await s.archivist.run('s')
    await s.archivist.notePending('s')

    expect(s.memory().chapters.map((chapter) => chapter.messageId)).toEqual(['a1'])
    const ledger = await s.ledger()
    expect(ledger).toMatchObject({ settledThrough: 1, through: 3 })
    expect(ledger.facts[0]).toMatchObject({ value: '30铜', settled: { value: '37铜', chapter: 1 } })
    // The second chapter's pass was shown the balance after the first one.
    const third = s.complete.mock.calls.find(
      ([prompt]) => prompt.includes(FACTS_PROMPT) && prompt.includes('第3章正文')
    )
    expect(third?.[0]).toContain('f1：艾琳 / 钱袋 = 25铜')
  })

  it('confirms the pending changes when the chapter settles, without counting them twice', async () => {
    // The settled pass reports the same spending again; it must not be applied on top.
    const s = session((prompt) =>
      prompt.includes('本章正文：\n第2章正文') ? { facts: [note({ change: '-12铜', value: '25铜' })] } : {}
    )
    await s.archivist.run('s')
    await s.archivist.notePending('s')
    s.state.messages = [...s.state.messages, ...reply3()]
    await s.archivist.run('s')

    const settle = s.complete.mock.calls.find(
      ([prompt]) => prompt.includes('本章正文：\n第2章正文') && !prompt.includes(FACTS_PROMPT)
    )
    expect(settle?.[0]).toContain('p1：艾琳 / 钱袋 -12铜')
    expect(s.memory().facts[0]).toMatchObject({ value: '25铜', chapter: 2 })
    expect(s.state.records.some((record) => record.id === 'pending:a2')).toBe(false)
    expect((await s.ledger()).facts[0].value).toBe('30铜')
  })

  it('drops a pending change the author’s replies overturned', async () => {
    const s = session((prompt) =>
      prompt.includes('本章正文：\n第2章正文')
        ? {
            amendments: [
              { target: 'fact', ref: 'p1', action: 'drop', reason: '作者否定了', evidence: '艾琳走进了雨里' },
            ],
          }
        : {}
    )
    await s.archivist.run('s')
    await s.archivist.notePending('s')
    s.state.messages = [...s.state.messages, ...reply3()]
    await s.archivist.run('s')
    expect(s.memory().facts[0].value).toBe('37铜')
  })

  it('carries the author’s choice on a slip into the settled record', async () => {
    const s = session()
    s.complete.mockImplementation(async (prompt: string) => {
      if (prompt.includes(FACTS_PROMPT)) {
        return {
          text: prompt.includes('第2章正文')
            ? factsReply(note({ change: '-12铜', value: '26铜', stated: true }))
            : factsReply(),
          model: 'aux',
        }
      }
      const facts = prompt.includes('本章正文：\n第1章正文') ? [note({ value: '37铜', stated: true })] : []
      return { text: reply({ facts }), model: 'aux' }
    })
    await s.archivist.run('s')
    await s.archivist.notePending('s')
    expect((await s.ledger()).conflicts).toEqual([expect.objectContaining({ kind: 'sum', chosen: 'ledger' })])

    const stored = s.state.records.find((record) => record.id === 'pending:a2')
    if (stored?.kind !== 'pending') throw new Error('missing pending record')
    s.state.records = [
      ...s.state.records.filter((record) => record !== stored),
      { ...stored, resolutions: { '艾琳/钱袋': 'prose' } },
    ]
    s.state.messages = [...s.state.messages, ...reply3()]
    await s.archivist.run('s')
    expect(s.memory().facts[0]).toMatchObject({ value: '26铜' })
    expect(s.memory().changes).toEqual([])
  })

  it('reads a chapter again once its text is edited in place', async () => {
    const s = session()
    await s.archivist.run('s')
    await s.archivist.notePending('s')
    const before = s.factCalls()

    s.state.messages = s.state.messages.map((message) =>
      message.id === 'a3' ? msg('a3', 'assistant', '第3章正文（改）。艾琳走进了雨里。') : message
    )
    expect((await s.ledger()).missingFrom).toBe(3)
    await s.archivist.notePending('s')
    expect(s.factCalls()).toBe(before + 1)
    expect((await s.ledger()).missingFrom).toBeUndefined()
  })

  it('leaves a regenerated chapter’s numbers behind', async () => {
    const s = session()
    await s.archivist.run('s')
    await s.archivist.notePending('s')
    s.state.messages = [...s.state.messages.slice(0, -1), msg('a3b', 'assistant', '第3章正文重写。艾琳走进了雨里。')]

    expect((await s.ledger()).facts[0].value).toBe('25铜')
    await s.archivist.notePending('s')
    expect((await s.ledger()).facts[0].value).toBe('30铜')
  })

  it('does not read ahead while the background is far behind', async () => {
    const s = harness(story(8), { settleReplies: 2 })
    await s.archivist.notePending('s')
    expect(s.complete).not.toHaveBeenCalled()
  })

  it('does nothing when long-form support is off', async () => {
    const s = session()
    s.state.enabled = false
    await s.archivist.notePending('s')
    expect(s.complete).not.toHaveBeenCalled()
  })
})

describe('from a finished chapter to the next request', () => {
  const write = (chapters: number) => {
    const padding = '雨一直下，河水撞着桥墩。'.repeat(10)
    const messages = story(chapters).map((message) =>
      message.role === 'assistant' ? msg(message.id, 'assistant', textOf(message) + padding) : message
    )
    messages[5] = msg('a3', 'assistant', `她把蓝色的钥匙藏在了钟楼第三块松动的砖后面。艾琳走进了雨里。${padding}`)
    return messages
  }

  async function recorded(messages: Message[]) {
    const session = harness(messages)
    session.complete.mockImplementation(async (prompt: string) => ({
      text: prompt.includes('阶段总结')
        ? '这一段的总结。'
        : reply(
            prompt.includes('松动的砖')
              ? {
                  characters: [
                    {
                      name: '艾琳',
                      aliases: ['少女'],
                      traits: ['寡言'],
                      speech: '短促',
                      status: '藏起了钥匙',
                      evidence: '艾琳走进了雨里',
                    },
                  ],
                  hooksPlanted: [{ text: '钥匙藏在钟楼', evidence: '钟楼第三块松动的砖' }],
                }
              : {}
          ),
      model: 'aux',
    }))
    await session.archivist.run('s')
    return session
  }

  const request = (
    memory: ReturnType<typeof foldNovelMemory>,
    turns: ReturnType<typeof splitNovelHistory>['turns'],
    scanDepth?: number
  ) => {
    const snapshot = buildNovelSnapshot(memory)
    return assembleNovelContext({
      totalBudgetTokens: 2000,
      countTokens: (text) => text.length,
      systemPrompt: '',
      scanDepth,
      lore: snapshot.lore,
      turns,
      storySegments: snapshot.storySegments,
      coveredThroughTurnId: snapshot.coveredThroughMessageId,
      stateLines: snapshot.stateLines,
      stickyRemaining: snapshot.stickyRemaining,
    })
  }

  it('recalls foreshadowing from long ago with its original sentence, though the text never names it', async () => {
    const messages = write(30)
    const session = await recorded(messages)
    const context = request(
      session.memory(),
      splitNovelHistory([...messages, msg('now', 'user', '她决定回去。')]).turns
    )

    expect(context.manifest.droppedTurnCount).toBeGreaterThan(0)
    expect(context.turns.map((turn) => turn.id)).not.toContain('a3')
    expect(context.volatileBlock).toContain('钥匙藏在钟楼')
    expect(context.volatileBlock).toContain('第三块松动的砖')
  })

  it('keeps the character in the scene active when the reply only says 她', async () => {
    const messages = write(5)
    const session = await recorded(messages)
    session.state.records = session.state.records.map((record) =>
      record.kind === 'chapter' ? { ...record, note: { ...record.note, inScene: ['少女'] } } : record
    )
    // Only the reply is scanned, and it names nobody, so no keyword can bring the character in.
    const context = request(
      session.memory(),
      splitNovelHistory([...messages, msg('now', 'user', '她沉默了。')]).turns,
      1
    )

    expect(context.volatileBlock).toContain('性格：寡言')
    expect(context.volatileBlock).toContain('近期在场：艾琳')
  })

  it('tells the story of chapters that left the window, and only those', async () => {
    const messages = write(30)
    const session = await recorded(messages)
    const context = request(session.memory(), splitNovelHistory([...messages, msg('now', 'user', '继续')]).turns)

    expect(context.storySoFar).toContain('第1至10章')
    const last = context.turns.findLast((turn) => turn.role === 'assistant')
    expect(context.storySoFar).not.toContain(`第${last?.id.slice(1)}章：`)
  })
})
