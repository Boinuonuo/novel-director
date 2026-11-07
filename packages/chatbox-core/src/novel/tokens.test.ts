import { describe, expect, it } from 'vitest'
import { estimateTokensBySampling } from '../application/token-estimation/math'
import { estimateNovelTokens } from './tokens'

/** The passage the correction was calibrated on: 469 characters, 603 cl100k tokens. */
const PASSAGE = `雨是后半夜落下来的。艾琳靠在断桥的石栏上，听着河水一下一下地撞着桥墩，像有人在很远的地方敲门。她把霜牙横在膝头，用袖口慢慢擦去剑脊上的水珠，擦得很仔细，仿佛这是今夜唯一要紧的事。
“你不该回来。”身后有人说。
她没有回头。那个声音她认得，隔了七年，还是那样不紧不慢，每个字都像是先在舌尖上掂过分量才肯放出来。北境的使者总是这样说话，好像世上的一切都已经写好了，他只是来念给你听。
“师父死的那天，你也是这么跟他说的？”艾琳问。
对方沉默了片刻。雨声填满了这段空白。她听见靴底碾过碎石的声音，一步，又一步，停在三尺开外。这个距离她再熟悉不过，是一个人能拔剑而另一个人来不及退的距离。
“奥瑟的事，你知道的比你以为的少。”使者说，“而你想知道的，比你能承受的多。”
艾琳终于转过身来。灯笼的光从他肩头漏过来，照在他那只从不离身的铜壶上，壶身上凝着一层细密的水汽。她忽然想起小时候师父讲过的话：北边来的人，你要看他吃不吃东西。
她笑了一下，把剑收回鞘里，左手腕上那道旧疤在雨水里隐隐发白。
“那就从你少说的那部分讲起。”她说，“我有一整夜。”
`

describe('estimateNovelTokens', () => {
  it('lands close to the measured count on Chinese narrative prose', () => {
    const estimate = estimateNovelTokens(PASSAGE, 'default')
    expect(estimate).toBeGreaterThan(603 * 0.95)
    expect(estimate).toBeLessThan(603 * 1.05)
  })

  it('corrects Han text, and only Han text', () => {
    expect(estimateNovelTokens('风'.repeat(1000), 'default')).toBe(1450)
    const english = 'She walked along the river for a long while. '.repeat(40)
    expect(estimateNovelTokens(english, 'default')).toBe(estimateTokensBySampling(english, 'default'))
  })

  it('leaves DeepSeek on its published weights', () => {
    expect(estimateNovelTokens(PASSAGE, 'deepseek')).toBe(estimateTokensBySampling(PASSAGE, 'deepseek'))
  })

  it('counts empty text as nothing', () => {
    expect(estimateNovelTokens('', 'default')).toBe(0)
  })
})
