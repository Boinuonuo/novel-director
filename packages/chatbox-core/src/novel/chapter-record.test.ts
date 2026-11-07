import { describe, expect, it } from 'vitest'
import { extractTrailingOptions, keepEvidenced, parseArchivistReply, stripTrailingOptions } from './chapter-record'

const valid = {
  summary: '艾琳到了断桥。',
  inScene: ['艾琳'],
  characters: [{ name: '艾琳', evidence: '艾琳到了断桥' }],
  terms: [],
  hooksPlanted: [],
  hooksResolved: [],
}

describe('parseArchivistReply', () => {
  it('reads plain JSON and JSON wrapped in a code fence or text', () => {
    expect(parseArchivistReply(JSON.stringify(valid))?.summary).toBe('艾琳到了断桥。')
    expect(parseArchivistReply(`好的：\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)?.summary).toBe('艾琳到了断桥。')
  })

  it('rejects text without JSON, broken JSON, and a reply with no summary', () => {
    expect(parseArchivistReply('我无法完成')).toBeNull()
    expect(parseArchivistReply('{"summary": ')).toBeNull()
    expect(parseArchivistReply(JSON.stringify({ ...valid, summary: '  ' }))).toBeNull()
  })

  it('tolerates missing optional fields', () => {
    const note = parseArchivistReply('{"summary":"有事发生。"}')
    expect(note).toMatchObject({ summary: '有事发生。', characters: [], terms: [], hooksPlanted: [], inScene: [] })
  })

  it('drops one malformed item without losing the rest', () => {
    const note = parseArchivistReply(
      JSON.stringify({ ...valid, characters: [{ traits: 'no name' }, { name: '奥瑟', evidence: 'x' }] })
    )
    expect(note?.characters.map((item) => item.name)).toEqual(['奥瑟'])
  })
})

describe('keepEvidenced', () => {
  const chapter = '“你不该回来。”他说。\n雨是后半夜落下来的。'
  const note = (overrides: object) => ({ ...parseArchivistReply(JSON.stringify(valid))!, ...overrides })
  const hook = (evidence: string) => ({ hooksPlanted: [{ text: '线索', evidence }] })

  it('keeps a note whose quote is in the chapter', () => {
    expect(keepEvidenced(note(hook('雨是后半夜落下来的')), chapter).hooksPlanted).toHaveLength(1)
  })

  it('drops a note whose quote is not', () => {
    expect(keepEvidenced(note(hook('雪是后半夜落下来的')), chapter).hooksPlanted).toEqual([])
    expect(keepEvidenced(note(hook('')), chapter).hooksPlanted).toEqual([])
  })

  it('ignores differences in spacing, quote marks and full-width forms', () => {
    expect(keepEvidenced(note(hook('"你不该回来。" 他说。')), chapter).hooksPlanted).toHaveLength(1)
  })

  it('keeps a character but clears a quote that was invented', () => {
    const kept = keepEvidenced(
      note({
        characters: [
          {
            name: '他',
            aliases: [],
            traits: [],
            speech: '',
            status: '',
            arc: '',
            quote: '我从未说过',
            evidence: '他说',
          },
        ],
      }),
      chapter
    )
    expect(kept.characters[0]).toMatchObject({ name: '他', quote: '' })
  })
})

describe('extractTrailingOptions', () => {
  it('reads the options a chapter ends with, without their labels', () => {
    expect(extractTrailingOptions('正文。\n\n接下来：\nA. 去钟楼\nB. 追上使者\nC. 原地等待')).toEqual([
      '去钟楼',
      '追上使者',
      '原地等待',
    ])
  })

  it('reads options dressed as bold list items', () => {
    expect(extractTrailingOptions('正文。\n\n- **A.** 去钟楼\n- **B.** 追上**使者**')).toEqual(['去钟楼', '追上使者'])
    expect(extractTrailingOptions('正文。\n\n**A**：去钟楼\n\n**B**：离开')).toEqual(['去钟楼', '离开'])
  })

  it('finds none in a chapter without a block of them', () => {
    expect(extractTrailingOptions('正文。\n\nA. 只有一个')).toEqual([])
    expect(extractTrailingOptions('A. 第一条\nB. 第二条\n\n她走了。')).toEqual([])
    expect(extractTrailingOptions('她走了。')).toEqual([])
  })
})

describe('stripTrailingOptions', () => {
  it('cuts options dressed as bold list items', () => {
    expect(stripTrailingOptions('正文。\n\n接下来：\n- **A.** 去钟楼\n- **B.** 离开')).toBe('正文。')
  })

  const body = '艾琳走到桥头，停下了脚步。'

  it.each([
    ['letters', `${body}\n\nA. 拔剑\nB. 离开\nC. 询问`],
    ['full-width marks', `${body}\n\nA、拔剑\nB、离开`],
    ['numbers', `${body}\n\n1. 拔剑\n2. 离开\n3. 询问`],
    ['circled numbers', `${body}\n\n①：拔剑\n②：离开`],
    ['named options', `${body}\n\n选项A：拔剑\n选项B：离开`],
    ['a heading above them', `${body}\n\n接下来：\nA. 拔剑\nB. 离开`],
    ['blank lines between them', `${body}\n\nA. 拔剑\n\nB. 离开\n\nC. 询问`],
  ])('removes %s', (_label, chapter) => {
    expect(stripTrailingOptions(chapter)).toBe(body)
  })

  it('leaves a chapter without options whole', () => {
    expect(stripTrailingOptions(body)).toBe(body)
  })

  it('leaves a numbered list inside the story alone', () => {
    const chapter = `清单上写着：\n1. 盐\n2. 铁\n她把清单收好，转身走了。`
    expect(stripTrailingOptions(chapter)).toBe(chapter)
  })

  it('does not treat a single trailing line as options', () => {
    const chapter = `${body}\n\nA. 孤零零的一行`
    expect(stripTrailingOptions(chapter)).toBe(chapter)
  })
})
