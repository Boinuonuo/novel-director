import { keyMatches, prepareScanText, type ScanText } from './text'
import type { ActivatedLore, LoreActivationOptions, LoreActivationResult, LoreEntry, LoreSecondaryLogic } from './types'

const DEFAULT_MAX_RECURSION_DEPTH = 2

/** The first primary key that matches, or undefined when the entry does not trigger. */
function matchEntry(entry: LoreEntry, scan: ScanText): string | undefined {
  const caseSensitive = entry.caseSensitive === true
  const primary = entry.keys.find((key) => keyMatches(key, scan, caseSensitive))
  if (primary === undefined) return undefined

  const secondary = (entry.secondaryKeys ?? []).filter((key) => key.trim())
  if (secondary.length === 0) return primary

  const hits = secondary.map((key) => keyMatches(key, scan, caseSensitive))
  const logic: LoreSecondaryLogic = entry.secondaryLogic ?? 'andAny'
  const pass =
    logic === 'andAny'
      ? hits.some(Boolean)
      : logic === 'andAll'
        ? hits.every(Boolean)
        : logic === 'notAny'
          ? !hits.some(Boolean)
          : !hits.every(Boolean)
  return pass ? primary : undefined
}

function compareActivated(a: ActivatedLore, b: ActivatedLore): number {
  const byPriority = (b.entry.priority ?? 0) - (a.entry.priority ?? 0)
  if (byPriority !== 0) return byPriority
  return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0
}

/**
 * Decide which lore entries are active for one turn.
 *
 * `scanTexts` is the text window to search (recent turns plus the author's
 * current instruction). Constant entries are always active. Keyword hits can in
 * turn activate other entries through their content (recursion), up to
 * `maxRecursionDepth` extra passes. Entries with `sticky` stay active for that
 * many turns after a hit; thread `nextStickyRemaining` into the next call.
 * The result order is deterministic.
 */
export function activateLore(
  entries: readonly LoreEntry[],
  scanTexts: readonly string[],
  options: LoreActivationOptions = {}
): LoreActivationResult {
  const maxDepth = Math.max(0, options.maxRecursionDepth ?? DEFAULT_MAX_RECURSION_DEPTH)
  const stickyIn = options.stickyRemaining ?? {}
  const enabled = entries.filter((entry) => entry.enabled !== false)
  const active = new Map<string, ActivatedLore>()

  for (const entry of enabled) {
    if (entry.constant) active.set(entry.id, { entry, reason: 'constant', depth: 0 })
  }

  const baseText = scanTexts.join('\n\n')
  const baseScan = prepareScanText(baseText)
  for (const entry of enabled) {
    if (active.has(entry.id)) continue
    const matchedKey = matchEntry(entry, baseScan)
    if (matchedKey !== undefined) active.set(entry.id, { entry, reason: 'keyword', matchedKey, depth: 0 })
  }

  let foundLastPass = active.size > 0
  for (let depth = 1; depth <= maxDepth && foundLastPass; depth++) {
    const combined = prepareScanText([baseText, ...[...active.values()].map((item) => item.entry.content)].join('\n\n'))
    const found: ActivatedLore[] = []
    for (const entry of enabled) {
      if (active.has(entry.id) || entry.excludeFromRecursion) continue
      const matchedKey = matchEntry(entry, combined)
      if (matchedKey !== undefined) found.push({ entry, reason: 'recursive', matchedKey, depth })
    }
    for (const item of found) active.set(item.entry.id, item)
    foundLastPass = found.length > 0
  }

  for (const entry of enabled) {
    if (active.has(entry.id)) continue
    if ((stickyIn[entry.id] ?? 0) > 0) active.set(entry.id, { entry, reason: 'sticky', depth: 0 })
  }

  const nextStickyRemaining: Record<string, number> = {}
  for (const { entry, reason } of active.values()) {
    if (reason === 'keyword' || reason === 'recursive') {
      if ((entry.sticky ?? 0) > 0) nextStickyRemaining[entry.id] = entry.sticky as number
    } else if (reason === 'sticky') {
      const left = (stickyIn[entry.id] ?? 0) - 1
      if (left > 0) nextStickyRemaining[entry.id] = left
    }
  }

  return { activated: [...active.values()].sort(compareActivated), nextStickyRemaining }
}
