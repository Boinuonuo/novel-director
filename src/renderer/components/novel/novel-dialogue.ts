import type { Element, ElementContent, Root, Text } from 'hast'

const closingQuote: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"' }
const excluded = new Set(['code', 'pre', 'a', 'script', 'style', 'math', 'svg'])
const openingQuote = /[“「『"]/u

/** Presentation only: keep the original text and Markdown structure intact. */
export function rehypeNovelDialogue() {
  return (tree: Root) => {
    const findBlocks = (node: Root | Element) => {
      for (const child of node.children) {
        if (child.type !== 'element' || excluded.has(child.tagName)) continue
        if (child.tagName === 'p' || child.tagName === 'li') colorInline(child, [])
        else findBlocks(child)
      }
    }
    findBlocks(tree)
  }
}

function colorInline(node: Element, quotes: string[]) {
  node.children = node.children.flatMap((child): ElementContent[] => {
    if (child.type === 'element') {
      const classes = String(child.properties.className ?? '')
      if (!excluded.has(child.tagName) && !classes.includes('katex')) colorInline(child, quotes)
      return [child]
    }
    if (child.type !== 'text') return [child]
    return colorText(child, quotes)
  })
}

function colorText(node: Text, quotes: string[]): ElementContent[] {
  // Most prose nodes are narration: preserve their identity and avoid a character scan.
  if (quotes.length === 0 && !openingQuote.test(node.value)) return [node]
  const result: ElementContent[] = []
  let start = 0
  const push = (end: number, dialogue: boolean) => {
    if (end <= start) return
    const text: Text = { type: 'text', value: node.value.slice(start, end) }
    result.push(
      dialogue
        ? {
            type: 'element',
            tagName: 'span',
            properties: { className: ['novel-dialogue'] },
            children: [text],
          }
        : text
    )
    start = end
  }
  for (let index = 0; index < node.value.length; index++) {
    const char = node.value[index]
    if (quotes.length > 0 && char === quotes.at(-1)) {
      quotes.pop()
      if (quotes.length === 0) push(index + 1, true)
    } else if (closingQuote[char]) {
      if (quotes.length === 0) push(index, false)
      quotes.push(closingQuote[char])
    }
  }
  push(node.value.length, quotes.length > 0)
  return result
}
