import type { NovelAssemblyRecord, NovelContextSnapshot, NovelContextSourcePort } from '@chatbox/core/novel'
import type { ModelInterface } from '@shared/models/types'
import type { Message, SessionSettings, Settings } from '@shared/types'
import { describe, expect, test, vi } from 'vitest'
import { type NovelScaffoldOptions, prepareNovelScaffold } from './novel-scaffold'

const model = { modelId: 'test-model' } as unknown as ModelInterface

const msg = (id: string, role: Message['role'], text: string): Message => ({
  id,
  role,
  contentParts: [{ type: 'text', text }],
})

/** A chapter-and-reply conversation ending in the author's current reply. */
function conversation(chapters: number, reply: string): Message[] {
  const messages: Message[] = [msg('system', 'system', '你是一位擅长古风悬疑的小说家。')]
  for (let i = 1; i <= chapters; i++) {
    messages.push(msg(`u${i}`, 'user', `选A，继续第${i}章。`))
    messages.push(msg(`a${i}`, 'assistant', `第${i}章：${'风从旧城吹来。'.repeat(60)}`))
  }
  messages.push(msg('current', 'user', reply))
  return messages
}

const lore = [
  { id: 'frost', name: '霜牙', keys: ['霜牙'], content: '霜牙的剑鞘内侧刻着第七代守桥人的名字：奥瑟。' },
  { id: 'law', name: '记忆之价', keys: [], constant: true, content: '魔法的代价是记忆。' },
]

function source(snapshot: NovelContextSnapshot | undefined) {
  const read = vi.fn(async (_sessionId: string) => snapshot)
  const recordAssembly = vi.fn((_sessionId: string, _record: NovelAssemblyRecord) => {})
  return { read, recordAssembly } satisfies NovelContextSourcePort
}

function options(promptMsgs: Message[], store: NovelContextSourcePort | undefined): NovelScaffoldOptions {
  return {
    sessionId: 'session-1',
    settings: { provider: 'openai', modelId: 'test-model', novelMode: true } as SessionSettings,
    globalSettings: {} as Settings,
    model,
    promptMsgs,
    instructions: '工具说明。',
    source: store,
  }
}

describe('prepareNovelScaffold', () => {
  test('adds nothing without a store, without records, or when the store fails', async () => {
    const messages = conversation(2, '继续。')
    await expect(prepareNovelScaffold(options(messages, undefined))).resolves.toBeUndefined()
    await expect(prepareNovelScaffold(options(messages, source(undefined)))).resolves.toBeUndefined()
    const failing: NovelContextSourcePort = { read: vi.fn().mockRejectedValue(new Error('db locked')) }
    await expect(prepareNovelScaffold(options(messages, failing))).resolves.toBeUndefined()
  })

  test('reads the records of this session', async () => {
    const store = source({ lore: [] })
    await prepareNovelScaffold({ ...options(conversation(1, '继续。'), store), pathMessageIds: ['u1', 'a1'] })
    expect(store.read).toHaveBeenCalledWith('session-1', ['u1', 'a1'])
  })

  test('puts constant lore ahead of the existing instructions', async () => {
    const scaffold = await prepareNovelScaffold(options(conversation(1, '继续。'), source({ lore })))
    expect(scaffold?.instructions).toMatch(/## 世界规则[\s\S]*魔法的代价是记忆[\s\S]*工具说明。$/)
  })

  test('leaves instructions and messages as they are when there is nothing to add', async () => {
    const messages = conversation(1, '继续。')
    const scaffold = await prepareNovelScaffold(options(messages, source({ lore: [] })))
    expect(scaffold?.instructions).toBe('工具说明。')
    expect(scaffold?.promptMsgs).toBe(messages)
    expect(scaffold?.addContext(messages)).toBe(messages)
  })

  test('adds triggered lore in front of the current reply', async () => {
    const messages = conversation(1, '她拔出霜牙。')
    const scaffold = await prepareNovelScaffold(options(messages, source({ lore })))

    const final = scaffold?.addContext(scaffold.promptMsgs) ?? []
    const last = JSON.stringify(final.at(-1))

    expect(last).toContain('奥瑟')
    expect(last.indexOf('奥瑟')).toBeLessThan(last.indexOf('她拔出霜牙。'))
  })

  test('keeps every turn until they are recorded', async () => {
    const messages = conversation(120, '继续。')
    const store = source({ lore: [], budgetTokens: 3000 })
    const scaffold = await prepareNovelScaffold(options(messages, store))

    expect(scaffold?.promptMsgs).toBe(messages)
    expect(store.recordAssembly.mock.calls[0][1].manifest).toMatchObject({ droppedTurnCount: 0, overBudget: true })
  })

  test('lets recorded chapters leave the window and tells their story instead', async () => {
    const messages = conversation(120, '继续。')
    const store = source({
      lore: [],
      budgetTokens: 6000,
      storySoFar: '艾琳离开了村子，踏上寻找守桥人的路。',
      coveredThroughMessageId: 'a120',
    })
    const scaffold = await prepareNovelScaffold(options(messages, store))

    const text = JSON.stringify(scaffold?.promptMsgs)
    expect(text).toContain('【前情提要】')
    expect(text).toContain('第120章')
    expect(text).not.toContain('第1章：')
    expect(store.recordAssembly.mock.calls[0][1].manifest.usedTokens).toBeLessThanOrEqual(6000)
  })

  test('hands sticky counters to the store and reads them back', async () => {
    const entry = { id: 'omen', keys: ['预兆'], sticky: 2, content: '乌鸦盘旋是凶兆。' }
    const store = source({ lore: [entry] })
    await prepareNovelScaffold(options(conversation(1, '出现了不祥的预兆。'), store))
    expect(store.recordAssembly.mock.calls[0][1].nextStickyRemaining).toEqual({ omen: 2 })

    const later = await prepareNovelScaffold(
      options(conversation(1, '继续写。'), source({ lore: [entry], stickyRemaining: { omen: 1 } }))
    )
    expect(JSON.stringify(later?.addContext(later.promptMsgs).at(-1))).toContain('乌鸦盘旋是凶兆')
  })

  test('keeps working when recording the assembly fails', async () => {
    const store: NovelContextSourcePort = {
      read: async () => ({ lore }),
      recordAssembly: vi.fn().mockRejectedValue(new Error('disk full')),
    }
    await expect(prepareNovelScaffold(options(conversation(1, '继续。'), store))).resolves.toBeDefined()
  })

  test('clamps the budget to a safe share of the model window', async () => {
    const store = source({ lore: [], budgetTokens: 60_000 })
    const globalSettings = {
      providers: { openai: { models: [{ modelId: 'test-model', contextWindow: 10_000 }] } },
    } as unknown as Settings
    await prepareNovelScaffold({ ...options(conversation(1, '继续。'), store), globalSettings })

    // usable window = 10_000 minus the 25% output reserve = 7_500; the request may use 90% of it.
    expect(store.recordAssembly.mock.calls[0][1].manifest.totalBudgetTokens).toBe(6750)
  })

  test('counts Chinese prose at its real weight', async () => {
    const store = source({ lore: [] })
    await prepareNovelScaffold(options([msg('u1', 'user', '风'.repeat(1000))], store))
    expect(store.recordAssembly.mock.calls[0][1].manifest.tiers.t2.tokens).toBe(1450)
  })

  test('counts what the system slot already holds', async () => {
    const store = source({ lore: [] })
    await prepareNovelScaffold(options([msg('s', 'system', '风'.repeat(100)), msg('u1', 'user', '继续。')], store))
    expect(store.recordAssembly.mock.calls[0][1].manifest.tiers.t0.tokens).toBeGreaterThan(145)
  })

  test('uses English wording when the records ask for it', async () => {
    const scaffold = await prepareNovelScaffold(
      options(
        conversation(1, 'Frostfang appears.'),
        source({ language: 'en', lore: [{ ...lore[0], keys: ['Frostfang'] }] })
      )
    )
    expect(JSON.stringify(scaffold?.addContext(scaffold.promptMsgs).at(-1))).toContain('## World info')
  })
})
