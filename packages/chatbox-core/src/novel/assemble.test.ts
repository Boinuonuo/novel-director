import { describe, expect, it } from 'vitest'
import { assembleNovelContext } from './assemble'
import { resolveTierCaps, splitParagraphs, trimParagraphsFromFront, truncateKeepingHead } from './budget'
import type { LoreEntry, NovelAssemblyInput, NovelTurn } from './types'

/** One token per UTF-16 code unit: exact, linear and easy to reason about in tests. */
const count = (text: string) => text.length
/** A different shape: CJK code points cost 2, everything else 1. Invariants must hold for both. */
const weightedCount = (text: string) => [...text].reduce((sum, ch) => sum + (/\p{Script=Han}/u.test(ch) ? 2 : 1), 0)

const turn = (id: string, role: NovelTurn['role'], text: string): NovelTurn => ({ id, role, text })
const lore = (id: string, overrides: Partial<LoreEntry> = {}): LoreEntry => ({
  id,
  name: id.toUpperCase(),
  keys: [id],
  content: 'x'.repeat(800),
  ...overrides,
})

function input(overrides: Partial<NovelAssemblyInput> = {}): NovelAssemblyInput {
  return {
    totalBudgetTokens: 10_000,
    countTokens: count,
    systemPrompt: 'You are a novelist.',
    lore: [],
    turns: [turn('u1', 'user', 'Continue the story.')],
    ...overrides,
  }
}

describe('resolveTierCaps', () => {
  it('uses default shares', () => {
    expect(resolveTierCaps(1000)).toEqual({ t0: 100, t1: 150, t3: 250 })
  })
  it('clamps invalid shares and falls back to defaults for non-numbers', () => {
    expect(resolveTierCaps(1000, { t0: -1, t1: Number.NaN, t3: 0.1 })).toEqual({ t0: 0, t1: 150, t3: 100 })
  })
  it('scales shares down so verbatim prose keeps at least 40%', () => {
    const caps = resolveTierCaps(1000, { t0: 0.5, t1: 0.5, t3: 0.5 })
    expect(caps.t0 + caps.t1 + caps.t3).toBeLessThanOrEqual(600)
  })
  it('treats a non-finite or negative budget as zero', () => {
    expect(resolveTierCaps(Number.NaN)).toEqual({ t0: 0, t1: 0, t3: 0 })
    expect(resolveTierCaps(-5)).toEqual({ t0: 0, t1: 0, t3: 0 })
  })
})

describe('paragraph trimming', () => {
  it('splits on blank lines and drops empties', () => {
    expect(splitParagraphs('a\n\n\n b \n \nc\n')).toEqual(['a', 'b', 'c'])
  })
  it('drops the oldest paragraphs first', () => {
    expect(trimParagraphsFromFront(['aaaa', 'bb', 'cc'], count, 6)).toEqual({
      kept: ['bb', 'cc'],
      droppedCount: 1,
      truncated: false,
    })
    expect(trimParagraphsFromFront([], count, 6)).toEqual({ kept: [], droppedCount: 0, truncated: false })
  })

  it('truncates, rather than drops, a newest paragraph that is too big on its own', () => {
    const newest = '甲乙丙丁戊。己庚辛壬癸。子丑寅卯辰。'
    const result = trimParagraphsFromFront(['older paragraph', newest], count, 12)
    expect(result.droppedCount).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0].startsWith('甲乙丙丁戊。')).toBe(true)
    expect(result.kept[0].endsWith('……')).toBe(true)
    expect(count(result.kept[0])).toBeLessThanOrEqual(12)
  })
})

describe('truncateKeepingHead', () => {
  it('returns text that already fits unchanged', () => {
    expect(truncateKeepingHead('短文。', count, 10)).toBe('短文。')
  })
  it('cuts at a sentence boundary and marks the cut', () => {
    expect(truncateKeepingHead('第一句。第二句。第三句。', count, 10)).toBe('第一句。第二句。……')
  })
  it('falls back to a hard cut inside a single over-long sentence', () => {
    const cut = truncateKeepingHead('甲'.repeat(50), count, 8)
    expect(count(cut)).toBeLessThanOrEqual(8)
    expect(cut.endsWith('……')).toBe(true)
    expect(cut.startsWith('甲')).toBe(true)
  })
  it('returns an empty string when not even the mark fits', () => {
    expect(truncateKeepingHead('甲'.repeat(50), count, 1)).toBe('')
  })
})

describe('assembleNovelContext', () => {
  it('keeps everything when it all fits', () => {
    const result = assembleNovelContext(
      input({
        storySoFar: 'Earlier, A happened.\n\nThen B happened.',
        stateLines: ['Eileen: at the bridge'],
        lore: [lore('frost', { keys: ['frostfang'], content: 'A cold blade.' })],
        turns: [turn('a1', 'assistant', 'She walked.'), turn('u1', 'user', 'She draws frostfang.')],
      })
    )
    expect(result.turns.map((item) => item.id)).toEqual(['a1', 'u1'])
    expect(result.storySoFar).toContain('Then B happened.')
    expect(result.volatileBlock).toContain('Eileen: at the bridge')
    expect(result.volatileBlock).toContain('A cold blade.')
    expect(result.manifest.overBudget).toBe(false)
    expect(result.manifest.droppedTurnCount).toBe(0)
    expect(result.manifest.lore).toEqual([
      expect.objectContaining({ id: 'frost', reason: 'keyword', matchedKey: 'frostfang', included: true }),
    ])
  })

  it('returns only the system prompt and the instruction when there is nothing else', () => {
    const result = assembleNovelContext(input())
    expect(result.constantLoreText).toBe('')
    expect(result.volatileBlock).toBe('')
    expect(result.storySoFar).toBe('')
    expect(result.turns).toHaveLength(1)
  })

  describe('tier 0', () => {
    it('puts constant lore in the system text and never in the volatile block', () => {
      const result = assembleNovelContext(
        input({ lore: [lore('law', { constant: true, keys: [], content: 'Magic costs memory.' })] })
      )
      expect(result.constantLoreText).toContain('## 世界规则')
      expect(result.constantLoreText).toContain('Magic costs memory.')
      expect(result.volatileBlock).toBe('')
    })

    it('defaults to Chinese wording and switches to English on request', () => {
      const given = input({
        stateLines: ['艾琳：在断桥边'],
        lore: [lore('frost', { keys: ['frost'] }), lore('law', { constant: true, keys: [] })],
        turns: [turn('u1', 'user', 'frost')],
      })
      const zh = assembleNovelContext(given)
      expect(zh.constantLoreText).toContain('## 世界规则')
      expect(zh.volatileBlock).toContain('## 当前状态')
      expect(zh.volatileBlock).toContain('## 相关设定')
      expect(zh.volatileBlock).toContain('不属于故事正文')
      expect(zh.volatileBlock).not.toMatch(/World info|Current state/)

      const en = assembleNovelContext({ ...given, language: 'en' })
      expect(en.constantLoreText).toContain('## World rules')
      expect(en.volatileBlock).toContain('## Current state')
      expect(en.volatileBlock).toContain('## World info')
      expect(en.volatileBlock).not.toContain('当前状态')
    })

    it('drops constant lore by lowest priority when over its cap, keeping the prompt intact', () => {
      const result = assembleNovelContext(
        input({
          systemPrompt: 'S'.repeat(100),
          lore: [
            lore('k1', { constant: true, keys: [], priority: 5, content: 'a'.repeat(400) }),
            lore('k2', { constant: true, keys: [], priority: 1, content: 'b'.repeat(400) }),
            lore('k3', { constant: true, keys: [], priority: 9, content: 'c'.repeat(400) }),
          ],
        })
      )
      const byId = Object.fromEntries(result.manifest.lore.map((item) => [item.id, item]))
      expect(byId.k3.included).toBe(true)
      expect(byId.k1.included).toBe(true)
      expect(byId.k2).toMatchObject({ included: false, droppedFor: 'budget' })
      expect(result.manifest.tiers.t0.tokens).toBeLessThanOrEqual(result.manifest.tiers.t0.cap)
    })

    it('never trims the system prompt, even above the tier cap', () => {
      const prompt = 'S'.repeat(300)
      const result = assembleNovelContext(
        input({
          totalBudgetTokens: 2000,
          systemPrompt: prompt,
          lore: [lore('k', { constant: true, keys: [] })],
        })
      )
      expect(result.constantLoreText).toBe('')
      expect(result.manifest.tiers.t0.tokens).toBe(300)
      expect(result.manifest.tiers.t0.tokens).toBeGreaterThan(result.manifest.tiers.t0.cap)
      expect(result.manifest.lore[0]).toMatchObject({ included: false, droppedFor: 'budget' })
    })
  })

  describe('tier 3', () => {
    it('keeps state ahead of lore and drops the lowest-priority lore first', () => {
      const result = assembleNovelContext(
        input({
          stateLines: ['Eileen: at the bridge', 'Holt: wounded', 'Gate: locked'],
          lore: [lore('a', { priority: 9 }), lore('b', { priority: 5 }), lore('c', { priority: 1 })],
          turns: [turn('u1', 'user', 'a b c')],
        })
      )
      expect(result.manifest.droppedStateLines).toBe(0)
      const included = result.manifest.lore.filter((item) => item.included).map((item) => item.id)
      expect(included).toEqual(['a', 'b'])
      expect(result.manifest.lore.find((item) => item.id === 'c')).toMatchObject({ droppedFor: 'budget' })
      expect(result.manifest.tiers.t3.tokens).toBeLessThanOrEqual(result.manifest.tiers.t3.cap)
    })

    it('trims state from the end when state alone is over the cap', () => {
      const lines = Array.from({ length: 12 }, (_, i) => `Entity ${i}: ${'v'.repeat(300)}`)
      const result = assembleNovelContext(input({ stateLines: lines }))
      expect(result.manifest.droppedStateLines).toBeGreaterThan(0)
      expect(result.volatileBlock).toContain('Entity 0:')
      expect(result.volatileBlock).not.toContain('Entity 11:')
      expect(result.manifest.tiers.t3.tokens).toBeLessThanOrEqual(result.manifest.tiers.t3.cap)
    })

    it('emits no block when nothing is relevant', () => {
      expect(assembleNovelContext(input({ lore: [lore('zzz')] })).volatileBlock).toBe('')
    })

    it('only scans the most recent turns for keywords', () => {
      const turns = [
        turn('t1', 'user', 'old mention of dragon'),
        turn('t2', 'assistant', 'x'),
        turn('t3', 'user', 'y'),
        turn('t4', 'assistant', 'z'),
        turn('t5', 'user', 'now'),
      ]
      const entries = [lore('dragon', { content: 'Scaly.' })]
      expect(assembleNovelContext(input({ lore: entries, turns, scanDepth: 5 })).volatileBlock).toContain('Scaly.')
      expect(assembleNovelContext(input({ lore: entries, turns, scanDepth: 2 })).volatileBlock).toBe('')
    })
  })

  describe('tier 1', () => {
    it('drops the oldest summary paragraphs first', () => {
      const paragraphs = ['P1', 'P2', 'P3', 'P4', 'P5'].map((label) => `${label} ${'p'.repeat(397)}`)
      const result = assembleNovelContext(input({ storySoFar: paragraphs.join('\n\n') }))
      expect(result.storySoFar).toBe(paragraphs.slice(2).join('\n\n'))
      expect(result.manifest.droppedSummaryParagraphs).toBe(2)
      expect(result.manifest.summaryTruncated).toBe(false)
      expect(result.manifest.tiers.t1.tokens).toBeLessThanOrEqual(result.manifest.tiers.t1.cap)
    })

    it('keeps an oversized summary, cut short, instead of losing it', () => {
      const sentences = Array.from({ length: 300 }, (_, i) => `第${i}句关于艾琳的设定。`).join('')
      const result = assembleNovelContext(input({ storySoFar: sentences }))
      expect(result.storySoFar.startsWith('第0句关于艾琳的设定。')).toBe(true)
      expect(result.storySoFar.endsWith('……')).toBe(true)
      expect(result.manifest.summaryTruncated).toBe(true)
      expect(result.manifest.tiers.t1.tokens).toBeLessThanOrEqual(result.manifest.tiers.t1.cap)
      expect(result.manifest.overBudget).toBe(false)
    })
  })

  describe('tier 2', () => {
    // With no system text a 5000 budget leaves 3000 for prose, after the 750 and 1250 reserved for tiers 1 and 3.
    const history = (count: number) =>
      Array.from({ length: count }, (_, i) => turn(`t${i}`, i % 2 ? 'user' : 'assistant', 'x'.repeat(100)))
    const prose = (turns: NovelTurn[], coveredThroughTurnId?: string, overrides: Partial<NovelAssemblyInput> = {}) =>
      assembleNovelContext(
        input({ totalBudgetTokens: 5000, systemPrompt: '', turns, coveredThroughTurnId, ...overrides })
      )

    it('drops nothing when nothing is recorded, however long the history', () => {
      const result = prose(history(200))
      expect(result.turns).toHaveLength(200)
      expect(result.manifest.droppedTurnCount).toBe(0)
      expect(result.manifest.overBudget).toBe(true)
    })

    it('drops nothing when the recorded turn is not in the window', () => {
      expect(prose(history(200), 'an-older-turn').turns).toHaveLength(200)
    })

    it('drops recorded turns, oldest first, in whole chunks', () => {
      const turns = history(50)
      const result = prose(turns, 't48')
      // 30 turns fit, so 20 could go; the window start rounds up to the next chunk of six.
      expect(result.manifest.droppedTurnCount).toBe(24)
      expect(result.turns[0].id).toBe('t24')
      expect(result.turns.at(-1)?.id).toBe('t49')
      expect(result.manifest.usedTokens).toBeLessThanOrEqual(5000)
    })

    it('never drops a turn newer than the recorded one', () => {
      const result = prose(history(50), 't10')
      expect(result.turns[0].id).toBe('t11')
      expect(result.manifest.droppedTurnCount).toBe(11)
    })

    it('keeps the window still between chunks as the story grows', () => {
      const dropped = [50, 51, 52, 53, 54, 55].map((count) => {
        const turns = history(count)
        return prose(turns, turns.at(-2)?.id).manifest.droppedTurnCount
      })
      expect(dropped).toEqual([24, 24, 24, 24, 24, 30])
    })

    it('does not move the window when one turn needs more or less context', () => {
      const turns = history(50)
      const small = prose(turns, 't48', { stateLines: ['a'] })
      const large = prose(turns, 't48', { stateLines: Array.from({ length: 8 }, (_, i) => `s${i} ${'v'.repeat(120)}`) })
      expect(large.manifest.tiers.t3.tokens).toBeGreaterThan(small.manifest.tiers.t3.tokens)
      expect(large.manifest.keptTurnIds).toEqual(small.manifest.keptTurnIds)
    })

    it('always keeps the two newest chapters and their replies, even over budget', () => {
      const big = 'x'.repeat(2000)
      const turns = [
        turn('old', 'assistant', 'x'.repeat(100)),
        turn('u1', 'user', 'y'),
        turn('a1', 'assistant', big),
        turn('u2', 'user', 'y'),
        turn('a2', 'assistant', big),
        turn('cur', 'user', 'z'),
      ]
      const result = prose(turns, 'a2')
      expect(result.turns.map((item) => item.id)).toEqual(['a1', 'u2', 'a2', 'cur'])
      expect(result.manifest.overBudget).toBe(false)
    })

    it('keeps a short conversation whole', () => {
      const turns = history(3)
      expect(prose(turns, 't1').turns).toHaveLength(3)
    })
  })

  describe('stability and determinism', () => {
    it('keeps the system text byte-identical across turns while triggered lore changes', () => {
      const entries = [
        lore('law', { constant: true, keys: [], content: 'Magic costs memory.' }),
        lore('frost', { keys: ['frostfang'], content: 'A cold blade.' }),
        lore('bridge', { keys: ['bridge'], content: 'Broken.' }),
      ]
      const a = assembleNovelContext(input({ lore: entries, turns: [turn('u1', 'user', 'frostfang')] }))
      const b = assembleNovelContext(input({ lore: entries, turns: [turn('u2', 'user', 'the bridge')] }))
      expect(a.constantLoreText).toBe(b.constantLoreText)
      expect(a.volatileBlock).not.toBe(b.volatileBlock)
    })

    it('does not depend on the order lore is supplied in', () => {
      const entries = [lore('a', { priority: 1 }), lore('b', { priority: 1 }), lore('c', { priority: 3 })]
      const turns = [turn('u1', 'user', 'a b c')]
      const forward = assembleNovelContext(input({ lore: entries, turns }))
      const reversed = assembleNovelContext(input({ lore: [...entries].reverse(), turns }))
      expect(reversed).toEqual(forward)
    })

    it('threads sticky counters through to the next turn', () => {
      const entries = [lore('omen', { keys: ['omen'], sticky: 1, content: 'Bad sign.' })]
      const first = assembleNovelContext(input({ lore: entries, turns: [turn('u1', 'user', 'an omen')] }))
      expect(first.nextStickyRemaining).toEqual({ omen: 1 })
      const second = assembleNovelContext(
        input({ lore: entries, turns: [turn('u2', 'user', 'nothing')], stickyRemaining: first.nextStickyRemaining })
      )
      expect(second.volatileBlock).toContain('Bad sign.')
      expect(second.manifest.lore[0].reason).toBe('sticky')
    })

    it('does not mutate its input', () => {
      const given = input({ lore: [lore('a')], turns: [turn('u1', 'user', 'a')], stateLines: ['s'] })
      const before = JSON.stringify({ ...given, countTokens: undefined })
      assembleNovelContext(given)
      expect(JSON.stringify({ ...given, countTokens: undefined })).toBe(before)
    })
  })
})

describe('budget invariants over generated inputs', () => {
  /** Deterministic PRNG so a failure is reproducible from its seed. */
  function rng(seed: number) {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const words = ['frost', 'bridge', 'envoy', '艾琳', '霜牙', '使者', 'gate', '北境']

  function generate(seed: number, countTokens: (text: string) => number): NovelAssemblyInput {
    const random = rng(seed)
    const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))
    const text = (length: number) =>
      Array.from({ length }, () => (random() < 0.1 ? words[int(0, words.length - 1)] : 'w')).join(' ')
    const totalBudgetTokens = int(3000, 20_000)
    return {
      totalBudgetTokens,
      countTokens,
      systemPrompt: text(int(0, Math.floor(totalBudgetTokens / 40))),
      lore: Array.from({ length: int(0, 8) }, (_, index) => ({
        id: `l${index}`,
        keys: [words[int(0, words.length - 1)]],
        content: text(int(1, 300)),
        constant: random() < 0.25,
        priority: int(0, 5),
      })),
      turns: [
        ...Array.from({ length: int(0, 14) }, (_, index) =>
          turn(`t${index}`, index % 2 ? 'assistant' : 'user', text(int(1, 400)))
        ),
        turn('current', 'user', text(int(1, 30))),
      ],
      storySoFar: Array.from({ length: int(0, 8) }, () => text(int(1, 300))).join('\n\n'),
      stateLines: Array.from({ length: int(0, 30) }, () => text(int(1, 40))),
    }
  }

  for (const [label, countTokens] of [
    ['linear counter', count],
    ['weighted counter', weightedCount],
  ] as const) {
    it(`holds every tier cap and the total budget (${label})`, () => {
      for (let seed = 1; seed <= 300; seed++) {
        const generated = generate(seed, countTokens)
        const given = { ...generated, coveredThroughTurnId: generated.turns.at(-2)?.id }
        const result = assembleNovelContext(given)
        const { tiers, usedTokens, totalBudgetTokens } = result.manifest
        const context = `seed ${seed}`

        const systemTokens = countTokens(given.systemPrompt.trim())
        if (systemTokens <= tiers.t0.cap) expect(tiers.t0.tokens, context).toBeLessThanOrEqual(tiers.t0.cap)
        expect(tiers.t1.tokens, context).toBeLessThanOrEqual(tiers.t1.cap)
        expect(tiers.t3.tokens, context).toBeLessThanOrEqual(tiers.t3.cap)
        expect(usedTokens, context).toBeLessThanOrEqual(totalBudgetTokens)
        expect(result.manifest.overBudget, context).toBe(false)

        const recount =
          countTokens([given.systemPrompt.trim(), result.constantLoreText].filter(Boolean).join('\n\n')) +
          (result.storySoFar ? countTokens(result.storySoFar) : 0) +
          (result.volatileBlock ? countTokens(result.volatileBlock) : 0) +
          result.turns.reduce((sum, item) => sum + countTokens(item.text), 0)
        expect(usedTokens, context).toBe(recount)

        const k = result.turns.length
        expect(
          result.turns.map((item) => item.id),
          context
        ).toEqual(given.turns.slice(-k).map((item) => item.id))
        expect(result.turns.at(-1)?.id, context).toBe('current')
        expect(assembleNovelContext(given), context).toEqual(result)
        expect(assembleNovelContext(generated).turns, context).toEqual(generated.turns)
      }
    })
  }
})
