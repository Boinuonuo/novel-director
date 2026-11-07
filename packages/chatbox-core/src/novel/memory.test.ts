import { describe, expect, it } from 'vitest'
import type {
  ChapterNote,
  FactNote,
  NovelAmendment,
  NovelChapterRecord,
  NovelEditRecord,
  NovelRecord,
} from './chapter-record'
import { buildNovelSnapshot, foldNovelMemory } from './memory'

type CharacterNote = ChapterNote['characters'][number]

const person = (name: string, note: Partial<CharacterNote> = {}): CharacterNote => ({
  name,
  aliases: [],
  traits: [],
  speech: '',
  status: '',
  arc: '',
  quote: '',
  evidence: '',
  ...note,
})

const chapter = (
  id: string,
  note: Partial<NovelChapterRecord['note']> = {},
  extra: Partial<NovelChapterRecord> = {}
): NovelChapterRecord => ({
  kind: 'chapter',
  id,
  messageId: id,
  covers: [id],
  note: { summary: `${id}概要`, inScene: [], characters: [], terms: [], hooksPlanted: [], ...note },
  resolvedHookIds: [],
  model: 'aux',
  createdAt: 1,
  ...extra,
})

const edit = (fields: Partial<NovelEditRecord> & Pick<NovelEditRecord, 'target' | 'key'>): NovelEditRecord => ({
  kind: 'edit',
  id: `edit:${fields.target}:${fields.key}`,
  action: 'update',
  atChapter: 1,
  createdAt: 2,
  ...fields,
})

const amendment = (fields: Partial<NovelAmendment>): NovelAmendment => ({
  target: 'character',
  key: '艾琳',
  action: 'amend',
  field: '',
  value: '',
  reason: '后文改了',
  ...fields,
})

const fold = (records: NovelRecord[], ...path: string[]) => foldNovelMemory(records, path)

describe('the author outranks the background', () => {
  it('keeps a deleted character out, under its aliases too, until restored', () => {
    const records: NovelRecord[] = [
      chapter('a1', { characters: [person('幽灵', { aliases: ['影子'] })], inScene: ['幽灵'] }),
      chapter('a2', { characters: [person('影子', { traits: ['阴冷'] })], inScene: ['影子'] }),
      edit({ target: 'character', key: '幽灵', action: 'delete' }),
    ]
    const memory = fold(records, 'a1', 'a2')

    expect(memory.characters).toEqual([])
    expect(memory.inScene).toEqual([])
    expect(memory.deleted).toEqual([{ target: 'character', key: '幽灵', label: '幽灵' }])

    const restored = fold(records.slice(0, 2), 'a1', 'a2')
    expect(restored.characters.map((item) => item.name)).toEqual(['幽灵'])
  })

  it('keeps a deleted term out when a later chapter mentions it again', () => {
    const term = { name: '霜牙', aliases: [], description: '佩剑', evidence: '' }
    const memory = fold(
      [
        chapter('a1', { terms: [term] }),
        chapter('a2', { terms: [term] }),
        edit({ target: 'term', key: '霜牙', action: 'delete' }),
      ],
      'a1',
      'a2'
    )
    expect(memory.terms).toEqual([])
  })

  it('removes a deleted hook from memory and from the request', () => {
    const records = [
      chapter('a1', { hooksPlanted: [{ text: '钥匙', evidence: '原话' }] }),
      edit({ target: 'hook', key: 'a1:0', action: 'delete' }),
    ]
    const memory = fold(records, 'a1')

    expect(memory.openHooks).toEqual([])
    expect(memory.deleted).toEqual([{ target: 'hook', key: 'a1:0', label: '钥匙' }])
    expect(buildNovelSnapshot(memory).stateLines?.join()).not.toContain('钥匙')
  })

  it('uses the rewritten hook and term in the request', () => {
    const memory = fold(
      [
        chapter('a1', {
          hooksPlanted: [{ text: '蓝钥匙', evidence: '原话' }],
          terms: [{ name: '霜牙', aliases: [], description: '佩剑', evidence: '' }],
        }),
        edit({ target: 'hook', key: 'a1:0', patch: { text: '银钥匙' } }),
        edit({ target: 'term', key: '霜牙', patch: { text: '断过一次的佩剑' } }),
      ],
      'a1'
    )
    const snapshot = buildNovelSnapshot(memory)

    expect(snapshot.stateLines?.join()).toContain('银钥匙')
    expect(snapshot.lore?.find((entry) => entry.name === '霜牙')?.content).toBe('断过一次的佩剑')
  })

  it('pins traits and speech against later chapters', () => {
    const memory = fold(
      [
        chapter('a1', { characters: [person('艾琳', { traits: ['暴躁'], speech: '粗声' })] }),
        chapter('a2', { characters: [person('艾琳', { traits: ['话多'], speech: '尖声' })] }),
        edit({ target: 'character', key: '艾琳', patch: { traits: ['寡言'], speech: '短促' } }),
      ],
      'a1',
      'a2'
    )
    expect(memory.characters[0]).toMatchObject({ traits: ['寡言'], speech: '短促' })
  })

  it('lets a state stand until a later chapter moves on', () => {
    const records = [
      chapter('a1', { characters: [person('艾琳', { status: '在桥上' })] }),
      edit({ target: 'character', key: '艾琳', patch: { status: '在钟楼' }, atChapter: 1 }),
      chapter('a2', { characters: [person('艾琳')] }),
      chapter('a3', { characters: [person('艾琳', { status: '在河边' })] }),
    ]
    expect(fold(records, 'a1', 'a2').characters[0].status).toBe('在钟楼')
    expect(fold(records, 'a1', 'a2', 'a3').characters[0].status).toBe('在河边')
  })

  it('does not let the background touch what the author edited', () => {
    const memory = fold(
      [
        chapter('a1', { hooksPlanted: [{ text: '钥匙', evidence: '原话' }] }),
        chapter('a2', {}, { amendments: [amendment({ target: 'hook', key: 'a1:0', action: 'drop' })] }),
        edit({ target: 'hook', key: 'a1:0', patch: { text: '作者的钥匙' } }),
      ],
      'a1',
      'a2'
    )
    expect(memory.openHooks.map((hook) => hook.text)).toEqual(['作者的钥匙'])
    expect(memory.changes).toEqual([])
  })

  it('leaves a chapter summary out of the story when deleted', () => {
    const memory = fold(
      [chapter('a1'), chapter('a2'), edit({ target: 'chapter', key: 'a1', action: 'delete' })],
      'a1',
      'a2'
    )
    expect(memory.segments.map((segment) => segment.text)).toEqual(['第2章：a2概要'])
    expect(memory.deleted).toEqual([{ target: 'chapter', key: 'a1', label: '第1章的概要' }])
  })

  it('prefers the rewritten paragraph until a newer one is built on later edits', () => {
    const rollup: NovelRecord = {
      kind: 'rollup',
      id: 'rollup:a1',
      chapterIds: ['a1', 'a2'],
      summary: '两章总结',
      model: 'aux',
      createdAt: 1,
    }
    const rewritten = edit({ target: 'rollup', key: 'rollup:a1', patch: { text: '作者的总结' } })
    expect(fold([chapter('a1'), chapter('a2'), rollup, rewritten], 'a1', 'a2').segments[0].text).toBe(
      '第1至2章：作者的总结'
    )
    expect(
      fold([chapter('a1'), chapter('a2'), { ...rollup, createdAt: 3 }, rewritten], 'a1', 'a2').segments[0].text
    ).toBe('第1至2章：两章总结')
  })
})

describe('corrections from the background', () => {
  it('finds a character by alias and rewrites the field it names', () => {
    const memory = fold(
      [
        chapter('a1', { characters: [person('艾琳', { aliases: ['少女'], traits: ['暴躁'] })] }),
        chapter(
          'a2',
          {},
          {
            amendments: [
              amendment({ key: '少女', field: 'traits', value: '寡言、谨慎' }),
              amendment({ key: '少女', field: 'status', value: '在钟楼' }),
            ],
          }
        ),
      ],
      'a1',
      'a2'
    )
    expect(memory.characters[0]).toMatchObject({ traits: ['寡言', '谨慎'], status: '在钟楼' })
    expect(memory.changes).toHaveLength(2)
  })

  it('ignores an amendment of something that is not in the records', () => {
    const memory = fold(
      [chapter('a1', {}, { amendments: [amendment({ key: '路人', field: 'status', value: 'x' })] })],
      'a1'
    )
    expect(memory.changes).toEqual([])
  })

  it('drops a term and a character', () => {
    const memory = fold(
      [
        chapter('a1', {
          characters: [person('艾琳')],
          terms: [{ name: '霜牙', aliases: [], description: '佩剑', evidence: '' }],
        }),
        chapter(
          'a2',
          {},
          { amendments: [amendment({ action: 'drop' }), amendment({ target: 'term', key: '霜牙', action: 'drop' })] }
        ),
      ],
      'a1',
      'a2'
    )
    expect(memory.characters).toEqual([])
    expect(memory.terms).toEqual([])
  })
})

describe('numbers', () => {
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
  const price = (value: string): FactNote => ({ ...held(value), kind: 'anchor', owner: '', name: '通铺' })

  it('keeps the latest value of each number along the path', () => {
    const records = [
      chapter('a1', { facts: [held('37铜')] }),
      chapter('a2', { facts: [held('25铜', { change: '-12铜' })] }),
    ]
    expect(fold(records, 'a1', 'a2').facts).toEqual([
      expect.objectContaining({ owner: '艾琳', value: '25铜', change: '-12铜', chapter: 2 }),
    ])
    expect(fold(records, 'a1').facts[0].value).toBe('37铜')
  })

  it('files a number under the character it belongs to, whatever alias was used', () => {
    const memory = fold(
      [
        chapter('a1', { characters: [person('艾琳', { aliases: ['少女'] })], facts: [held('37铜')] }),
        chapter('a2', { facts: [held('25铜', { owner: '少女' })] }),
      ],
      'a1',
      'a2'
    )
    expect(memory.facts).toHaveLength(1)
    expect(memory.facts[0].value).toBe('25铜')
  })

  it('counts chapters recorded before numbers were kept', () => {
    const memory = fold([chapter('a1', { facts: undefined }), chapter('a2', { facts: [] })], 'a1', 'a2')
    expect(memory.unscannedChapters).toBe(1)
  })

  it('gives the writer the numbers ahead of foreshadowing, so a tight budget cuts the foreshadowing first', () => {
    const memory = fold(
      [
        chapter('a1', {
          facts: [held('37铜'), { ...held('C级冒险者'), name: '等级' }, price('一晚十二铜')],
          hooksPlanted: [{ text: '钥匙', evidence: '原话' }],
        }),
      ],
      'a1'
    )
    const lines = buildNovelSnapshot(memory).stateLines ?? []
    expect(lines[0]).toContain('记到第1章')
    expect(lines[1]).toBe('艾琳：钱袋 37铜；等级 C级冒险者')
    expect(lines[2]).toBe('世界基准：通铺＝一晚十二铜')
    expect(lines.at(-1)).toContain('钥匙')
  })

  it('adds nothing to the request when no number is known', () => {
    expect(buildNovelSnapshot(fold([chapter('a1')], 'a1')).stateLines).toEqual([])
  })

  it('lets the background drop or correct a number', () => {
    const memory = fold(
      [
        chapter('a1', { facts: [held('37铜'), price('一晚十二铜')] }),
        chapter(
          'a2',
          {},
          {
            amendments: [
              amendment({ target: 'fact', key: '艾琳/钱袋', value: '30铜' }),
              amendment({ target: 'fact', key: 'world/通铺', action: 'drop' }),
            ],
          }
        ),
      ],
      'a1',
      'a2'
    )
    expect(memory.facts.map((fact) => fact.value)).toEqual(['30铜'])
    expect(memory.changes).toHaveLength(2)
  })

  it('holds the author value until a later chapter moves it, and keeps a world value for good', () => {
    const records = [
      chapter('a1', { facts: [held('37铜'), price('一晚十二铜')] }),
      edit({ target: 'fact', key: '艾琳/钱袋', patch: { text: '50铜' }, atChapter: 1 }),
      edit({ target: 'fact', key: 'world/通铺', patch: { text: '一晚十五铜' }, atChapter: 1 }),
      chapter('a2', { facts: [held('40铜'), price('一晚十二铜')] }),
    ]
    expect(fold(records, 'a1').facts.map((fact) => fact.value)).toEqual(['50铜', '一晚十五铜'])
    expect(fold(records, 'a1', 'a2').facts.map((fact) => fact.value)).toEqual(['40铜', '一晚十五铜'])
  })

  it('marks what the background worked out, and puts it after what the story said', () => {
    const inferred = { ...price('约30铜'), name: '日薪', inferred: true, basis: '通铺一晚十二铜' }
    const lines =
      buildNovelSnapshot(fold([chapter('a1', { facts: [inferred, price('一晚十二铜')] })], 'a1')).stateLines ?? []
    expect(lines.slice(-2)).toEqual(['世界基准：通铺＝一晚十二铜', '世界推定：日薪＝约30铜'])
  })

  it('makes an inference the author edited theirs, so the background stops touching it', () => {
    const inferred = { ...price('约30铜'), name: '日薪', inferred: true, basis: '通铺' }
    const memory = fold(
      [
        chapter('a1', { facts: [inferred] }),
        edit({ target: 'fact', key: 'world/日薪', patch: { text: '约40铜' } }),
        chapter('a2', { facts: [{ ...inferred, value: '约35铜' }] }),
      ],
      'a1',
      'a2'
    )
    expect(memory.facts[0]).toMatchObject({ value: '约40铜', inferred: false })
  })

  it('keeps a deleted number out when a later chapter mentions it', () => {
    const memory = fold(
      [
        chapter('a1', { facts: [price('一晚十二铜')] }),
        chapter('a2', { facts: [price('一晚十二铜')] }),
        edit({ target: 'fact', key: 'world/通铺', action: 'delete' }),
      ],
      'a1',
      'a2'
    )
    expect(memory.facts).toEqual([])
    expect(memory.deleted).toEqual([{ target: 'fact', key: 'world/通铺', label: '通铺' }])
  })
})
