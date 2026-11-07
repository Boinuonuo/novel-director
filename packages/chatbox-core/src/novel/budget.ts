import { type CountTokens, DEFAULT_NOVEL_BUDGET_TOKENS, DEFAULT_TIER_SHARES, type TierShares } from './types'

/** Tiers 0, 1 and 3 may not together claim more than this, so verbatim prose always keeps a floor. */
const MAX_COMBINED_SHARE = 0.6

export interface TierCaps {
  t0: number
  t1: number
  t3: number
}

/**
 * Turn shares into token caps. Invalid shares fall back to the defaults, each
 * share is clamped to [0, 1], and if the three together exceed
 * {@link MAX_COMBINED_SHARE} they are scaled down proportionally.
 */
export function resolveTierCaps(totalBudgetTokens: number, shares: Partial<TierShares> = {}): TierCaps {
  const total = Number.isFinite(totalBudgetTokens) ? Math.max(0, Math.floor(totalBudgetTokens)) : 0
  const pick = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback
  let t0 = pick(shares.t0, DEFAULT_TIER_SHARES.t0)
  let t1 = pick(shares.t1, DEFAULT_TIER_SHARES.t1)
  let t3 = pick(shares.t3, DEFAULT_TIER_SHARES.t3)
  const sum = t0 + t1 + t3
  if (sum > MAX_COMBINED_SHARE) {
    const scale = MAX_COMBINED_SHARE / sum
    t0 *= scale
    t1 *= scale
    t3 *= scale
  }
  return { t0: Math.floor(total * t0), t1: Math.floor(total * t1), t3: Math.floor(total * t3) }
}

/**
 * Walk `items` in order and keep each one only if the rendered whole still fits.
 * An item that does not fit is dropped and later, smaller items may still fit.
 * The measure recounts the full candidate, so rounding in the counter can never
 * push the result past `maxTokens`.
 */
export function fitGreedy<T>(
  items: readonly T[],
  measure: (kept: readonly T[]) => number,
  maxTokens: number
): { kept: T[]; dropped: T[] } {
  const kept: T[] = []
  const dropped: T[] = []
  for (const item of items) {
    if (measure([...kept, item]) <= maxTokens) kept.push(item)
    else dropped.push(item)
  }
  return { kept, dropped }
}

/**
 * Keep the longest prefix of `items` that fits. Used where order is the point,
 * such as state records, so a short late record never jumps a long early one.
 */
export function fitPrefix<T>(
  items: readonly T[],
  measure: (kept: readonly T[]) => number,
  maxTokens: number
): { kept: T[]; dropped: T[] } {
  let count = 0
  while (count < items.length && measure(items.slice(0, count + 1)) <= maxTokens) count++
  return { kept: items.slice(0, count), dropped: items.slice(count) }
}

/** Split text into paragraphs on blank lines. Empty paragraphs are discarded. */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

const TRUNCATION_MARK = '……'
const SENTENCE_UNITS = /[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+/g

/**
 * Cut `text` down to fit, keeping its beginning, at a sentence boundary where
 * possible, and marking the cut. Falls back to a hard character cut when even the
 * first sentence is too long. Returns an empty string when nothing fits.
 */
export function truncateKeepingHead(text: string, countTokens: CountTokens, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) return text
  const withMark = (body: string) => `${body.trimEnd()}${TRUNCATION_MARK}`
  const units = text.match(SENTENCE_UNITS) ?? [text]
  let body = ''
  for (const unit of units) {
    if (countTokens(withMark(body + unit)) > maxTokens) break
    body += unit
  }
  if (body.trim()) return withMark(body)

  // Not even the first sentence fits: binary-search the longest head that does.
  const first = units[0] ?? text
  let low = 0
  let high = first.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (countTokens(withMark(first.slice(0, mid))) <= maxTokens) low = mid
    else high = mid - 1
  }
  return low > 0 ? withMark(first.slice(0, low)) : ''
}

/**
 * Drop the oldest paragraphs until the rest fits. If even the newest paragraph
 * alone is too large it is truncated (head kept) rather than dropped: a summary
 * that is a little short is better than a summary that silently disappears.
 */
export function trimParagraphsFromFront(
  paragraphs: readonly string[],
  countTokens: CountTokens,
  maxTokens: number
): { kept: string[]; droppedCount: number; truncated: boolean } {
  for (let start = 0; start < paragraphs.length; start++) {
    const kept = paragraphs.slice(start)
    if (countTokens(kept.join('\n\n')) <= maxTokens) return { kept, droppedCount: start, truncated: false }
  }
  if (paragraphs.length === 0) return { kept: [], droppedCount: 0, truncated: false }
  const newest = truncateKeepingHead(paragraphs[paragraphs.length - 1], countTokens, maxTokens)
  return { kept: newest ? [newest] : [], droppedCount: paragraphs.length - 1, truncated: newest !== '' }
}

/**
 * Token counts are estimates and the host wraps some text the assembler cannot
 * see, so a request never plans to fill more than this share of the usable window.
 */
export const NOVEL_WINDOW_SAFETY_RATIO = 0.9

/**
 * The budget one request really gets: the author's choice (or the default),
 * clamped to a safe share of the model's usable window when that is known.
 */
export function resolveNovelBudget(requestedTokens: number | undefined, usableWindowTokens?: number | null): number {
  const requested =
    typeof requestedTokens === 'number' && Number.isFinite(requestedTokens) && requestedTokens > 0
      ? Math.floor(requestedTokens)
      : DEFAULT_NOVEL_BUDGET_TOKENS
  if (typeof usableWindowTokens !== 'number' || !Number.isFinite(usableWindowTokens) || usableWindowTokens <= 0) {
    return requested
  }
  return Math.min(requested, Math.floor(usableWindowTokens * NOVEL_WINDOW_SAFETY_RATIO))
}
