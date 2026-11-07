import type { LoreEntry, NovelTurn } from '../types'

/**
 * A deterministic long-novel fixture for context evals. No model is involved:
 * filler prose is generated from a seeded RNG, and the planted facts ("needles")
 * use unique marker strings so a test can check whether a fact reached the writer.
 *
 * Filler vocabulary deliberately avoids every lore key, so a lore entry that
 * activates is always activated by an instruction the test wrote on purpose.
 */

export type FixtureLanguage = 'zh' | 'en'

export interface LoreProbe {
  entryId: string
  /** An author instruction that mentions the entry's key. */
  instruction: string
  /** A string that appears in the entry's content and nowhere else. */
  marker: string
}

export interface ProseFact {
  id: string
  /** 1-based chapter in which the fact is stated, in prose only (no lore entry). */
  chapter: number
  marker: string
  /** An instruction that depends on the fact without restating it. */
  query: string
}

export interface NovelFixture {
  language: FixtureLanguage
  turns: NovelTurn[]
  lore: LoreEntry[]
  loreProbes: LoreProbe[]
  proseFacts: ProseFact[]
  chapterCount: number
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ZH = {
  subjects: ['旅人', '老船夫', '守夜人', '村里的孩子', '商队的领队', '那位陌生的女子'],
  verbs: [
    '沿着河岸走了很久',
    '在篝火旁沉默着',
    '抬头望向阴沉的天空',
    '把行囊重新系紧',
    '听见远处传来钟声',
    '蹲下身查看泥地上的脚印',
  ],
  tails: [
    '风从旧城的方向吹来，带着潮湿的气味。',
    '没有人说话，只有柴火偶尔爆开的声音。',
    '天色一点点暗下去，路也变得难辨。',
    '远处的田野里，稻草人一动不动。',
  ],
  loreFacts: [
    ['艾琳', '艾琳左手腕上有一道旧疤，是幼年被铁链勒出的，她从不向人提起。', '旧疤'],
    ['霜牙', '霜牙的剑鞘内侧刻着第七代守桥人的名字：奥瑟。', '奥瑟'],
    ['北境使者', '北境使者从不进食，他随身的铜壶里装的是封存的雪水。', '封存的雪水'],
    ['断桥', '断桥的桥墩下埋着前朝的界碑，碑文只有拓片留存。', '前朝的界碑'],
    ['钟楼', '钟楼的钟只在有人说谎时才会自己鸣响一次。', '说谎时才会自己鸣响'],
  ],
  proseFacts: [
    {
      chapter: 3,
      marker: '第三块松动的砖',
      fact: '她把蓝色的钥匙藏在了旧城钟楼里第三块松动的砖后面。',
      query: '她决定去取回自己藏起来的那把钥匙。',
    },
    {
      chapter: 17,
      marker: '渡口的老柳树',
      fact: '老船夫低声说，真正的账本埋在渡口的老柳树下，别告诉任何人。',
      query: '老船夫终于愿意说出账本的下落。',
    },
  ],
}

const EN = {
  subjects: [
    'The traveler',
    'The old ferryman',
    'The night watchman',
    'A village child',
    'The caravan leader',
    'The stranger',
  ],
  verbs: [
    'walked along the riverbank for a long while',
    'sat silent by the fire',
    'looked up at the heavy sky',
    'tightened the pack again',
    'heard a bell far away',
    'crouched to read the tracks in the mud',
  ],
  tails: [
    'Wind carried the smell of damp from the old town.',
    'Nobody spoke; only the fire popped now and then.',
    'The light faded and the road grew hard to read.',
    'In the far field a scarecrow stood perfectly still.',
  ],
  loreFacts: [
    [
      'Eileen',
      'Eileen has an old scar on her left wrist, left by chains in childhood, and she never speaks of it.',
      'old scar on her left wrist',
    ],
    [
      'Frostfang',
      "Frostfang's scabbard is engraved on the inside with the seventh bridge-warden's name: Orsel.",
      'Orsel',
    ],
    ['northern envoy', 'The northern envoy never eats; his copper flask holds sealed snow-water.', 'sealed snow-water'],
    [
      'broken bridge',
      'A boundary stone of the old dynasty lies buried under the broken bridge pier; only rubbings survive.',
      'boundary stone of the old dynasty',
    ],
    ['bell tower', 'The bell tower chimes once on its own, but only when someone lies.', 'chimes once on its own'],
  ],
  proseFacts: [
    {
      chapter: 3,
      marker: 'third loose brick',
      fact: 'She hid the blue key behind the third loose brick in the old bell tower.',
      query: 'She decided to fetch the key she had hidden.',
    },
    {
      chapter: 17,
      marker: 'old willow at the ferry',
      fact: 'The ferryman whispered that the true ledger lay under the old willow at the ferry, and no one must know.',
      query: 'The ferryman finally agreed to say where the ledger was.',
    },
  ],
}

export function buildNovelFixture(
  language: FixtureLanguage,
  options: { chapters?: number; seed?: number } = {}
): NovelFixture {
  const chapterCount = options.chapters ?? 120
  const random = mulberry32(options.seed ?? 42)
  const text = language === 'zh' ? ZH : EN
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]
  const joiner = language === 'zh' ? '' : ' '
  const sentence = () =>
    `${pick(text.subjects)}${joiner}${pick(text.verbs)}${language === 'zh' ? '。' : '.'}${joiner}${pick(text.tails)}`

  const proseByChapter = new Map(text.proseFacts.map((fact) => [fact.chapter, fact.fact]))
  const turns: NovelTurn[] = []
  for (let chapter = 1; chapter <= chapterCount; chapter++) {
    turns.push({
      id: `u${chapter}`,
      role: 'user',
      text: language === 'zh' ? `继续写第${chapter}章，保持节奏。` : `Continue chapter ${chapter}, keep the pacing.`,
    })
    const sentences = Array.from({ length: 80 }, sentence)
    const planted = proseByChapter.get(chapter)
    if (planted) sentences.splice(40, 0, planted)
    turns.push({ id: `a${chapter}`, role: 'assistant', text: sentences.join(joiner) })
  }

  const lore: LoreEntry[] = text.loreFacts.map(([key, content], index) => ({
    id: `lore-${index}`,
    name: key,
    keys: [key],
    content,
    priority: text.loreFacts.length - index,
  }))
  const loreProbes: LoreProbe[] = text.loreFacts.map(([key, , marker], index) => ({
    entryId: `lore-${index}`,
    instruction:
      language === 'zh'
        ? `${key}出现在下一幕里，写一段它的细节。`
        : `Next scene features ${key}; write a detail about it.`,
    marker,
  }))
  const proseFacts: ProseFact[] = text.proseFacts.map((fact, index) => ({
    id: `fact-${index}`,
    chapter: fact.chapter,
    marker: fact.marker,
    query: fact.query,
  }))
  return { language, turns, lore, loreProbes, proseFacts, chapterCount }
}
