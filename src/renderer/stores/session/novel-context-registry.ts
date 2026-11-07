import type { NovelContextSourcePort } from '@chatbox/core/novel'

let source: NovelContextSourcePort | undefined

/**
 * The host-side reader for novel projects. The storage layer registers itself
 * here at startup. While nothing is registered, a novel session still writes,
 * just without lore, state or an author-maintained summary.
 */
export function setNovelContextSource(next: NovelContextSourcePort | undefined): void {
  source = next
}

export function getNovelContextSource(): NovelContextSourcePort | undefined {
  return source
}
