import { estimateTokensBySampling } from '../application/token-estimation/math'

/**
 * Tokens per Han character, punctuation included, in real Chinese narrative prose.
 * The shared estimator assumes 1, which undercounts such prose: a 469-character
 * passage measured 603 cl100k tokens against an estimate of 419.
 */
const HAN_TOKENS_PER_CHARACTER = 1.45

function countHanCharacters(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit >= 0x3400 && unit <= 0x9fff) count++
  }
  return count
}

/**
 * Token estimate for fiction. DeepSeek publishes its own weights, which the shared
 * estimator already applies; every other model gets the Chinese prose correction.
 */
export function estimateNovelTokens(text: string, tokenizerType: 'default' | 'deepseek'): number {
  const base = estimateTokensBySampling(text, tokenizerType)
  if (tokenizerType === 'deepseek') return base
  return Math.ceil(base + countHanCharacters(text) * (HAN_TOKENS_PER_CHARACTER - 1))
}
