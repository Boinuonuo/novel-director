const NUMBER = String.raw`\d[\d,]*|[零〇一二两三四五六七八九十百千万亿]+`
const UNIT = String.raw`[^\d\s,，、+\-−＝=零〇一二两三四五六七八九十百千万亿]*`
const AMOUNT_PART = new RegExp(`(${NUMBER})\\s*(${UNIT})`, 'y')
const RATE = new RegExp(`(${NUMBER})\\s*(${UNIT})\\s*[=＝]\\s*(${NUMBER})\\s*(${UNIT})`, 'u')

const DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}
const SECTION_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
const LARGE_UNITS: Record<string, number> = { 万: 10_000, 亿: 100_000_000 }

/** Chinese numerals as they appear in prose. A pair like 三两 means a measure, not a number, so it is refused. */
function parseChineseNumber(text: string): number | null {
  let total = 0
  let section = 0
  let digit = 0
  for (const char of text) {
    if (char in DIGITS) {
      if (digit !== 0) return null
      digit = DIGITS[char]
    } else if (char in SECTION_UNITS) {
      section += (digit || 1) * SECTION_UNITS[char]
      digit = 0
    } else if (char in LARGE_UNITS) {
      total = (total + section + digit) * LARGE_UNITS[char]
      section = 0
      digit = 0
    } else {
      return null
    }
  }
  return total + section + digit
}

function parseNumber(text: string): number | null {
  return /^\d/.test(text) ? Number(text.replaceAll(',', '')) : parseChineseNumber(text)
}

interface AmountPart {
  count: number
  unit: string
}

/** Reads `8银9铜`, `三十七枚铜币` or `-12铜`. Anything else, such as `C级冒险者`, is not an amount. */
function parseAmount(text: string): { negative: boolean; signed: boolean; parts: AmountPart[] } | null {
  const trimmed = text.trim()
  const signed = /^[+\-−]/.test(trimmed)
  const body = signed ? trimmed.slice(1).trim() : trimmed
  const parts: AmountPart[] = []
  AMOUNT_PART.lastIndex = 0
  while (AMOUNT_PART.lastIndex < body.length) {
    const match = AMOUNT_PART.exec(body)
    const count = match && parseNumber(match[1])
    if (match === null || count === null || !Number.isInteger(count)) return null
    parts.push({ count, unit: match[2] })
  }
  if (parts.length === 0 || (parts.length > 1 && parts.some((part) => !part.unit))) return null
  return { negative: /^[-−]/.test(trimmed), signed, parts }
}

export type ExchangeRates = ReadonlyMap<string, { unit: string; factor: number }>

/** Exchange rates the story has stated, such as `1银=100铜`, read from its reference values. */
export function collectExchangeRates(values: readonly string[]): ExchangeRates {
  const rates = new Map<string, { unit: string; factor: number }>()
  for (const value of values) {
    const match = RATE.exec(value)
    if (!match) continue
    const [from, to] = [parseNumber(match[1]), parseNumber(match[3])]
    if (from && to && match[2] && match[4] && to % from === 0) {
      rates.set(match[2], { unit: match[4], factor: to / from })
    }
  }
  return rates
}

/** How many of the smallest unit one `unit` is worth, following the chain of rates. */
function resolveUnit(unit: string, rates: ExchangeRates): { base: string; scale: number } {
  let base = unit
  let scale = 1
  for (let step = 0; step < 8; step++) {
    const rate = rates.get(base)
    if (!rate) break
    base = rate.unit
    scale *= rate.factor
  }
  return { base, scale }
}

function formatAmount(total: number, units: { unit: string; scale: number }[]): string {
  let rest = total
  const parts = units.flatMap(({ unit, scale }) => {
    const count = Math.floor(rest / scale)
    rest -= count * scale
    return count > 0 ? [`${count}${unit}`] : []
  })
  return parts.join('') || `0${units.at(-1)?.unit ?? ''}`
}

/** Units that all come down to one base, with how many of the base each is worth. */
function resolveAll(units: readonly string[], rates: ExchangeRates) {
  const resolved = new Map(units.map((unit) => [unit, resolveUnit(unit, rates)]))
  return new Set([...resolved.values()].map(({ base }) => base)).size === 1 ? resolved : null
}

const worthIn = (parts: readonly AmountPart[], resolved: ReadonlyMap<string, { scale: number }>) =>
  parts.reduce((sum, part) => sum + part.count * (resolved.get(part.unit)?.scale ?? 1), 0)

/**
 * The exact result of applying a signed change, such as `-12铜`, to a held amount.
 * Null when the sum cannot be done for certain: a value that is not an amount, units
 * no stated rate links, or a balance that would go below zero.
 */
export function applyChange(previous: string | undefined, change: string, rates: ExchangeRates = new Map()) {
  const before = previous === undefined ? null : parseAmount(previous)
  const delta = parseAmount(change)
  if (!before || before.signed || !delta?.signed) return null
  const resolved = resolveAll(
    [...before.parts, ...delta.parts].map(({ unit }) => unit),
    rates
  )
  if (!resolved) return null
  const total = worthIn(before.parts, resolved) + (delta.negative ? -1 : 1) * worthIn(delta.parts, resolved)
  if (total < 0) return null
  const order = [...resolved.entries()].map(([unit, { scale }]) => ({ unit, scale })).sort((a, b) => b.scale - a.scale)
  return formatAmount(total, order)
}

/** Whether two amounts are worth the same, such as `8银9铜` and `809铜`. Null when they cannot be compared. */
export function sameAmount(a: string, b: string, rates: ExchangeRates = new Map()): boolean | null {
  const left = parseAmount(a)
  const right = parseAmount(b)
  if (!left || !right || left.signed || right.signed) return null
  const resolved = resolveAll(
    [...left.parts, ...right.parts].map(({ unit }) => unit),
    rates
  )
  return resolved ? worthIn(left.parts, resolved) === worthIn(right.parts, resolved) : null
}

/**
 * A value worked out from a change rather than read from the prose is checked here,
 * because the model that reported it can slip on simple sums. When the sum can be
 * done exactly the result stands; anything it cannot read keeps the model's value.
 */
export function settleAmount(
  previous: string | undefined,
  change: string,
  claimed: string,
  rates: ExchangeRates = new Map()
): string {
  const total = applyChange(previous, change, rates)
  if (total === null) return claimed
  return sameAmount(claimed, total, rates) ? claimed : total
}
