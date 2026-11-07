import { describe, expect, it } from 'vitest'
import { activateLore } from './lorebook'
import { keyMatches, prepareScanText } from './text'
import type { LoreEntry } from './types'

function entry(id: string, overrides: Partial<LoreEntry> = {}): LoreEntry {
  return { id, keys: [id], content: `content of ${id}`, ...overrides }
}

const ids = (entries: LoreEntry[], scan: string[], options?: Parameters<typeof activateLore>[2]) =>
  activateLore(entries, scan, options).activated.map((item) => item.entry.id)

describe('keyMatches', () => {
  const match = (key: string, text: string, caseSensitive = false) =>
    keyMatches(key, prepareScanText(text), caseSensitive)

  it('matches Latin keys on word boundaries only', () => {
    expect(match('Eileen', 'Eileen drew her sword.')).toBe(true)
    expect(match('Eileen', 'She asked Eileen.')).toBe(true)
    expect(match('Eileen', "Eileen's blade")).toBe(true)
    expect(match('Eileen', 'Eileenx waved.')).toBe(false)
    expect(match('Eileen', 'xEileen waved.')).toBe(false)
    expect(match('Eileen', 'Eileen_2 waved.')).toBe(false)
  })

  it('treats a Han character next to a Latin key as a boundary', () => {
    expect(match('Eileen', 'Eileen说她不去。')).toBe(true)
    expect(match('Eileen', '她看见了Eileen。')).toBe(true)
  })

  it('matches keys in unsegmented scripts as substrings, including two-character names', () => {
    expect(match('霜牙', '艾琳拔出了霜牙，站在断桥边。')).toBe(true)
    expect(match('艾琳', '艾琳没有接。')).toBe(true)
    expect(match('霜牙', '艾琳拔出了长剑。')).toBe(false)
    expect(match('魔法', 'まほうの魔法')).toBe(true)
    expect(match('마법', '그는 마법사다')).toBe(true)
  })

  it('is case-insensitive by default and honors caseSensitive', () => {
    expect(match('frostfang', 'She drew Frostfang.')).toBe(true)
    expect(match('frostfang', 'She drew Frostfang.', true)).toBe(false)
    expect(match('Frostfang', 'She drew Frostfang.', true)).toBe(true)
  })

  it('folds full-width Latin to ASCII', () => {
    expect(match('Eileen', 'Ｅｉｌｅｅｎ说话了')).toBe(true)
  })

  it('supports regular-expression keys and survives invalid ones', () => {
    expect(match('/fro+st(fang)?/', 'the frooost wind')).toBe(true)
    expect(match('/^dragon$/m', 'a\ndragon\nb')).toBe(true)
    expect(match('/(/', 'anything ( here')).toBe(false)
  })

  it('never matches an empty key', () => {
    expect(match('', 'anything')).toBe(false)
    expect(match('   ', 'anything')).toBe(false)
  })

  it('matches keys that start or end with punctuation without needing a boundary there', () => {
    expect(match('Mr.', 'Mr. Holt arrived')).toBe(true)
    expect(match('C++', 'I know C++ well')).toBe(true)
  })
})

describe('activateLore', () => {
  it('activates on a primary key hit and reports the matched key', () => {
    const result = activateLore([entry('a', { keys: ['alpha', 'beta'] })], ['we met beta today'])
    expect(result.activated).toHaveLength(1)
    expect(result.activated[0]).toMatchObject({ reason: 'keyword', matchedKey: 'beta', depth: 0 })
  })

  it('ignores disabled entries, even constant ones', () => {
    const entries = [entry('a', { enabled: false }), entry('b', { constant: true, enabled: false })]
    expect(ids(entries, ['a b'])).toEqual([])
  })

  it('always activates constant entries', () => {
    const result = activateLore([entry('rules', { constant: true, keys: [] })], [])
    expect(result.activated[0]).toMatchObject({ reason: 'constant' })
  })

  describe('secondary keys', () => {
    const base = { keys: ['gate'], secondaryKeys: ['night', 'rain'] }
    const run = (logic: LoreEntry['secondaryLogic'], text: string) =>
      ids([entry('x', { ...base, secondaryLogic: logic })], [text])

    it('andAny needs at least one secondary hit (the default)', () => {
      expect(run(undefined, 'gate at night')).toEqual(['x'])
      expect(run('andAny', 'gate at dawn')).toEqual([])
    })
    it('andAll needs every secondary hit', () => {
      expect(run('andAll', 'gate, night, rain')).toEqual(['x'])
      expect(run('andAll', 'gate, night')).toEqual([])
    })
    it('notAny blocks on any secondary hit', () => {
      expect(run('notAny', 'gate at dawn')).toEqual(['x'])
      expect(run('notAny', 'gate in rain')).toEqual([])
    })
    it('notAll blocks only when every secondary hits', () => {
      expect(run('notAll', 'gate in rain')).toEqual(['x'])
      expect(run('notAll', 'gate, night, rain')).toEqual([])
    })
    it('requires a primary hit regardless of secondary keys', () => {
      expect(run('notAny', 'nothing relevant')).toEqual([])
    })
  })

  describe('recursion', () => {
    const chain = [
      entry('a', { keys: ['alpha'], content: 'mentions beta' }),
      entry('b', { keys: ['beta'], content: 'mentions gamma' }),
      entry('c', { keys: ['gamma'], content: 'mentions delta' }),
      entry('d', { keys: ['delta'], content: 'end' }),
    ]

    it('activates entries through the content of activated entries, up to the depth limit', () => {
      const result = activateLore(chain, ['alpha appears'], { maxRecursionDepth: 2 })
      expect(result.activated.map((item) => [item.entry.id, item.reason, item.depth])).toEqual([
        ['a', 'keyword', 0],
        ['b', 'recursive', 1],
        ['c', 'recursive', 2],
      ])
    })

    it('does not recurse when the depth is 0', () => {
      expect(ids(chain, ['alpha appears'], { maxRecursionDepth: 0 })).toEqual(['a'])
    })

    it('never activates an entry that excludes itself from recursion', () => {
      const entries = [chain[0], { ...chain[1], excludeFromRecursion: true }]
      expect(ids(entries, ['alpha appears'])).toEqual(['a'])
      expect(ids(entries, ['beta appears'])).toEqual(['b'])
    })

    it('lets constant entries trigger others through their content', () => {
      const entries = [entry('rules', { constant: true, keys: [], content: 'the gamma law' }), chain[2]]
      expect(ids(entries, [])).toEqual(['c', 'rules'])
    })
  })

  describe('sticky', () => {
    const sticky = entry('s', { keys: ['omen'], sticky: 2 })

    it('stays active for the configured number of further turns, then expires', () => {
      const turn1 = activateLore([sticky], ['an omen appears'])
      expect(turn1.activated[0].reason).toBe('keyword')
      expect(turn1.nextStickyRemaining).toEqual({ s: 2 })

      const turn2 = activateLore([sticky], ['nothing'], { stickyRemaining: turn1.nextStickyRemaining })
      expect(turn2.activated[0].reason).toBe('sticky')
      expect(turn2.nextStickyRemaining).toEqual({ s: 1 })

      const turn3 = activateLore([sticky], ['nothing'], { stickyRemaining: turn2.nextStickyRemaining })
      expect(turn3.activated[0].reason).toBe('sticky')
      expect(turn3.nextStickyRemaining).toEqual({})

      const turn4 = activateLore([sticky], ['nothing'], { stickyRemaining: turn3.nextStickyRemaining })
      expect(turn4.activated).toEqual([])
    })

    it('resets the counter when the keyword hits again while sticky', () => {
      const result = activateLore([sticky], ['omen again'], { stickyRemaining: { s: 1 } })
      expect(result.activated[0].reason).toBe('keyword')
      expect(result.nextStickyRemaining).toEqual({ s: 2 })
    })

    it('does not make a disabled entry sticky', () => {
      expect(ids([{ ...sticky, enabled: false }], ['nothing'], { stickyRemaining: { s: 2 } })).toEqual([])
    })
  })

  it('orders by priority descending, then id, regardless of input order', () => {
    const entries = [
      entry('c', { keys: ['x'], priority: 1 }),
      entry('b', { keys: ['x'], priority: 5 }),
      entry('a', { keys: ['x'], priority: 1 }),
    ]
    expect(ids(entries, ['x'])).toEqual(['b', 'a', 'c'])
    expect(ids([...entries].reverse(), ['x'])).toEqual(['b', 'a', 'c'])
  })

  it('does not mutate its inputs', () => {
    const entries = [entry('a', { keys: ['alpha'], content: 'mentions beta' }), entry('b', { keys: ['beta'] })]
    const before = JSON.stringify(entries)
    activateLore(entries, ['alpha'])
    expect(JSON.stringify(entries)).toBe(before)
  })
})
