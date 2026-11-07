import { describe, expect, it } from 'vitest'
import { collectExchangeRates } from './amounts'
import type { FactNote, NovelChapterRecord, NovelEditRecord, NovelPendingRecord, NovelRecord } from './chapter-record'
import { foldNovelLedger, reconcileFact, renderLedgerLines, settleFactNotes } from './ledger'
import { buildNovelSnapshot, foldNovelMemory } from './memory'

const held = (value: string, extra: Partial<FactNote> = {}): FactNote => ({
  kind: 'state',
  owner: '艾琳',
  name: '钱袋',
  value,
  change: '',
  stated: true,
  evidence: '',
  inferred: false,
  basis: '',
  ...extra,
})
const spent = (change: string, value: string, stated = false) => held(value, { change, stated })
const price = (value: string): FactNote => ({ ...held(value), kind: 'anchor', owner: '', name: '通铺' })

const chapter = (id: string, facts: FactNote[] = []): NovelChapterRecord => ({
  kind: 'chapter',
  id,
  messageId: id,
  covers: [id],
  note: { summary: `${id}概要`, inScene: [], characters: [], terms: [], hooksPlanted: [], facts },
  resolvedHookIds: [],
  model: 'aux',
  createdAt: 1,
})

const pending = (
  messageId: string,
  facts: FactNote[],
  extra: Partial<NovelPendingRecord> = {}
): NovelPendingRecord => ({
  kind: 'pending',
  id: `pending:${messageId}`,
  messageId,
  textHash: `h-${messageId}`,
  facts,
  model: 'aux',
  createdAt: 1,
  ...extra,
})

const edit = (fields: Partial<NovelEditRecord> & Pick<NovelEditRecord, 'key'>): NovelEditRecord => ({
  kind: 'edit',
  id: `edit:fact:${fields.key}`,
  target: 'fact',
  action: 'update',
  atChapter: 1,
  createdAt: 2,
  ...fields,
})

/** Chapter a1 settled; the rest are written but not settled. */
function ledgerOf(records: NovelRecord[], unsettled: string[], hashes: Record<string, string> = {}) {
  const memory = foldNovelMemory(records, ['a1', ...unsettled])
  return foldNovelLedger(
    memory,
    records,
    unsettled.map((id) => ({ messageId: id, textHash: hashes[id] ?? `h-${id}` }))
  )
}

const rates = collectExchangeRates([])

describe('reconcileFact', () => {
  it('corrects the model’s own sum without calling it a conflict', () => {
    expect(reconcileFact('37铜', spent('-12铜', '26铜'), rates, 'pending')).toEqual({ value: '25铜' })
  })

  it('keeps the sum over a stated balance that does not add up, unless the author takes the prose', () => {
    const note = spent('-12铜', '26铜', true)
    expect(reconcileFact('37铜', note, rates, 'pending')).toEqual({
      value: '25铜',
      conflict: { kind: 'sum', expected: '25铜', claimed: '26铜' },
    })
    expect(reconcileFact('37铜', note, rates, 'pending', 'prose').value).toBe('26铜')
  })

  it('takes an unexplained new amount from the prose, but notes the jump', () => {
    const result = reconcileFact('37铜', held('20铜'), rates, 'pending')
    expect(result).toEqual({ value: '20铜', conflict: { kind: 'jump', expected: '37铜', claimed: '20铜' } })
    expect(reconcileFact('37铜', held('20铜'), rates, 'pending', 'ledger').value).toBe('37铜')
  })

  it('compares amounts by worth, not by spelling', () => {
    const silver = collectExchangeRates(['1银=100铜'])
    expect(reconcileFact('8银9铜', held('809铜'), silver, 'pending')).toEqual({ value: '809铜' })
    expect(reconcileFact('C级', held('B级'), rates, 'pending')).toEqual({ value: 'B级' })
  })

  it('holds a world value against a pending chapter, and lets a settled one replace it', () => {
    expect(reconcileFact('一晚十二铜', price('一晚十五铜'), rates, 'pending').value).toBe('一晚十二铜')
    expect(reconcileFact('一晚十二铜', price('一晚十五铜'), rates, 'settled').value).toBe('一晚十五铜')
    expect(reconcileFact('一晚十二铜', price('一晚十五铜'), rates, 'settled', 'ledger').value).toBe('一晚十二铜')
  })
})

describe('settleFactNotes', () => {
  it('keeps what the prose claimed where the sum was kept over it', () => {
    const memory = foldNovelMemory([chapter('a1', [held('37铜')])], ['a1'])
    expect(settleFactNotes([spent('-12铜', '26铜', true)], memory)).toEqual([
      expect.objectContaining({ value: '25铜', claimed: '26铜' }),
    ])
    expect(settleFactNotes([spent('-12铜', '26铜', true)], memory, { '艾琳/钱袋': 'prose' })[0]).not.toHaveProperty(
      'claimed'
    )
  })
})

describe('foldNovelLedger', () => {
  const settled = chapter('a1', [held('37铜'), price('一晚十二铜')])

  it('adds the newest chapters’ changes onto the settled value, and says where it came from', () => {
    const ledger = ledgerOf(
      [settled, pending('a2', [spent('-12铜', '25铜')]), pending('a3', [spent('+5铜', '30铜')])],
      ['a2', 'a3']
    )
    expect(ledger).toMatchObject({ settledThrough: 1, through: 3 })
    expect(ledger.missingFrom).toBeUndefined()
    expect(ledger.facts[0]).toMatchObject({
      value: '30铜',
      chapter: 3,
      settled: { value: '37铜', chapter: 1 },
      pending: [
        { chapter: 2, change: '-12铜', value: '25铜' },
        { chapter: 3, change: '+5铜', value: '30铜' },
      ],
    })
  })

  it('works the sum out from the change, so a stale balance in an older record cannot leak in', () => {
    const ledger = ledgerOf([settled, pending('a2', [spent('-12铜', '99铜')])], ['a2'])
    expect(ledger.facts[0].value).toBe('25铜')
  })

  it('ignores a record made from other text, and stops counting there so no step is skipped', () => {
    const ledger = ledgerOf(
      [settled, pending('a2', [spent('-12铜', '25铜')]), pending('a3', [spent('-5铜', '20铜')])],
      ['a2', 'a3'],
      { a2: 'edited' }
    )
    expect(ledger).toMatchObject({ through: 1, missingFrom: 2 })
    expect(ledger.facts[0].value).toBe('37铜')
  })

  it('leaves out a pending record whose chapter is not on the path, such as a regenerated one', () => {
    const ledger = ledgerOf([settled, pending('old', [spent('-12铜', '25铜')])], ['a2'])
    expect(ledger.facts[0].value).toBe('37铜')
    expect(ledger.missingFrom).toBe(2)
  })

  it('reports a slip, takes the ledger by default and the prose once the author says so', () => {
    const slip = pending('a2', [spent('-12铜', '26铜', true)])
    const ledger = ledgerOf([settled, slip], ['a2'])
    expect(ledger.facts[0].value).toBe('25铜')
    expect(ledger.conflicts).toEqual([
      expect.objectContaining({
        kind: 'sum',
        chapter: 2,
        key: '艾琳/钱袋',
        expected: '25铜',
        claimed: '26铜',
        previous: '37铜',
        change: '-12铜',
        chosen: 'ledger',
        resolved: false,
      }),
    ])
    const chosen = ledgerOf([settled, { ...slip, resolutions: { '艾琳/钱袋': 'prose' } }], ['a2'])
    expect(chosen.facts[0].value).toBe('26铜')
    expect(chosen.conflicts[0]).toMatchObject({ chosen: 'prose', resolved: true })
  })

  it('does not let a new world value replace the old one before its chapter settles', () => {
    const ledger = ledgerOf([settled, pending('a2', [price('一晚十五铜')])], ['a2'])
    expect(ledger.facts.find((fact) => fact.kind === 'anchor')?.value).toBe('一晚十二铜')
    expect(ledger.conflicts[0]).toMatchObject({ kind: 'anchor', chosen: 'ledger' })
  })

  it('marks a number only a new chapter mentions as unconfirmed', () => {
    const ledger = ledgerOf([settled, pending('a2', [held('B级', { name: '等级' })])], ['a2'])
    expect(ledger.facts.find((fact) => fact.name === '等级')).toMatchObject({
      value: 'B级',
      settled: undefined,
      pending: [{ chapter: 2, change: '', value: 'B级' }],
    })
  })

  it('lets the author’s value stand over the chapters they had read, and closes the conflict', () => {
    const records = [
      settled,
      pending('a2', [spent('-12铜', '26铜', true)]),
      edit({ key: '艾琳/钱袋', patch: { text: '30铜' }, atChapter: 2 }),
    ]
    const ledger = ledgerOf(records, ['a2'])
    expect(ledger.facts[0]).toMatchObject({ value: '30铜', pending: [] })
    expect(ledger.conflicts).toEqual([])
  })

  it('keeps a number the author deleted out', () => {
    const ledger = ledgerOf(
      [settled, pending('a2', [spent('-12铜', '25铜')]), edit({ key: '艾琳/钱袋', action: 'delete' })],
      ['a2']
    )
    expect(ledger.facts.map((fact) => fact.key)).toEqual(['world/通铺'])
  })
})

describe('renderLedgerLines', () => {
  const settled = chapter('a1', [held('37铜'), price('一晚十二铜')])

  it('tells the writer the balance now, where it came from, and that it awaits the author', () => {
    const lines = renderLedgerLines(ledgerOf([settled, pending('a2', [spent('-12铜', '25铜')])], ['a2']))
    expect(lines[0]).toContain('已确认到第1章')
    expect(lines[0]).toContain('第2章刚写下的变化')
    expect(lines[1]).toBe('艾琳：钱袋 25铜（第1章 37铜 → 第2章 -12铜）')
    expect(lines[2]).toBe('世界基准：通铺＝一晚十二铜')
  })

  it('puts a slip first and tells the writer not to carry it on', () => {
    const lines = renderLedgerLines(ledgerOf([settled, pending('a2', [spent('-12铜', '26铜', true)])], ['a2']))
    expect(lines[0]).toBe('第2章正文写艾琳的钱袋是26铜，但37铜-12铜应为25铜。续写按25铜算，不要沿用26铜。')
  })

  it('drops a slip once a later chapter has moved the number on', () => {
    const lines = renderLedgerLines(
      ledgerOf(
        [settled, pending('a2', [spent('-12铜', '26铜', true)]), pending('a3', [spent('-5铜', '20铜')])],
        ['a2', 'a3']
      )
    )
    expect(lines.some((line) => line.includes('不要沿用'))).toBe(false)
    expect(lines).toContain('艾琳：钱袋 20铜（第1章 37铜 → 第2章 -12铜 → 第3章 -5铜）')
  })

  it('tells the writer where the counting stops when a chapter is not read yet', () => {
    const lines = renderLedgerLines(ledgerOf([settled], ['a2']))
    expect(lines[0]).toContain('记到第1章')
    expect(lines[0]).toContain('第2章起的增减还没记入')
  })

  it('reaches the writer before foreshadowing', () => {
    const records: NovelRecord[] = [
      { ...settled, note: { ...settled.note, hooksPlanted: [{ text: '钥匙', evidence: '原话' }] } },
      pending('a2', [spent('-12铜', '25铜')]),
    ]
    const memory = foldNovelMemory(records, ['a1', 'a2'])
    const ledger = foldNovelLedger(memory, records, [{ messageId: 'a2', textHash: 'h-a2' }])
    const lines = buildNovelSnapshot(memory, ledger).stateLines ?? []
    expect(lines.findIndex((line) => line.includes('25铜'))).toBeLessThan(
      lines.findIndex((line) => line.includes('钥匙'))
    )
  })
})
