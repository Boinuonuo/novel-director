/**
 * Keyword matching for lore keys, built for mixed Chinese/English prose.
 *
 * - Text is NFKC-normalized (full-width Latin folds to ASCII) and case-folded.
 * - Keys in unsegmented scripts (Han, kana, Hangul, Thai) match as substrings,
 *   because those scripts have no word boundaries.
 * - Other keys must sit on word boundaries, where an unsegmented-script character
 *   counts as a boundary: "Eileen" matches inside "Eileen说" but not in "Eileenx".
 * - `/pattern/flags` keys are regular expressions.
 */

const UNSEGMENTED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u
const WORD_CHAR = /[\p{L}\p{N}_]/u
const REGEX_KEY = /^\/(.+)\/([a-z]*)$/s
const VALID_REGEX_FLAGS = new Set(['i', 'm', 's', 'u'])
const REGEX_CACHE_LIMIT = 500

export interface ScanText {
  /** NFKC form with the original case; regular-expression keys run against this. */
  nfkc: string
  /** NFKC form, lower-cased; plain case-insensitive keys run against this. */
  folded: string
}

export function prepareScanText(text: string): ScanText {
  const nfkc = text.normalize('NFKC')
  return { nfkc, folded: nfkc.toLowerCase() }
}

/** Whether a character belongs to a word, for boundary purposes. Unsegmented scripts never do. */
function isWordChar(character: string): boolean {
  return WORD_CHAR.test(character) && !UNSEGMENTED_SCRIPT.test(character)
}

function characterBefore(text: string, index: number): string {
  if (index <= 0) return ''
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) return text.slice(index - 2, index)
  return text[index - 1]
}

function characterAt(text: string, index: number): string {
  if (index >= text.length) return ''
  return String.fromCodePoint(text.codePointAt(index) as number)
}

function includesAtBoundary(haystack: string, needle: string): boolean {
  const needsLeft = isWordChar(characterAt(needle, 0))
  const needsRight = isWordChar(characterBefore(needle, needle.length))
  let from = 0
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) return false
    const left = characterBefore(haystack, index)
    const right = characterAt(haystack, index + needle.length)
    const leftOk = !needsLeft || left === '' || !isWordChar(left)
    const rightOk = !needsRight || right === '' || !isWordChar(right)
    if (leftOk && rightOk) return true
    from = index + 1
  }
  return false
}

const regexCache = new Map<string, RegExp | null>()

/** Compile a `/pattern/flags` key. Returns null when it is not a regex key or is invalid. */
function compileRegexKey(key: string, caseSensitive: boolean): RegExp | null {
  const match = REGEX_KEY.exec(key)
  if (!match) return null
  const flags = new Set(match[2].split('').filter((flag) => VALID_REGEX_FLAGS.has(flag)))
  if (!caseSensitive) flags.add('i')
  const flagText = [...flags].sort().join('')
  const cacheKey = `${flagText}/${match[1]}`
  if (regexCache.has(cacheKey)) return regexCache.get(cacheKey) ?? null
  let compiled: RegExp | null = null
  try {
    compiled = new RegExp(match[1], flagText)
  } catch {
    compiled = null
  }
  if (regexCache.size >= REGEX_CACHE_LIMIT) regexCache.clear()
  regexCache.set(cacheKey, compiled)
  return compiled
}

/** Whether `key` occurs in the prepared text. An empty key never matches. */
export function keyMatches(key: string, scan: ScanText, caseSensitive = false): boolean {
  if (!key.trim()) return false
  const regex = compileRegexKey(key, caseSensitive)
  if (regex) return regex.test(scan.nfkc)
  const normalized = key.normalize('NFKC')
  const needle = caseSensitive ? normalized : normalized.toLowerCase()
  const haystack = caseSensitive ? scan.nfkc : scan.folded
  if (UNSEGMENTED_SCRIPT.test(needle)) return haystack.includes(needle)
  return includesAtBoundary(haystack, needle)
}
