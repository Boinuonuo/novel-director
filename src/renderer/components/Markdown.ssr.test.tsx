// @vitest-environment jsdom

import ReactDOMServer from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/platform', () => ({
  default: {
    type: 'desktop',
    exporter: { exportByUrl: vi.fn(), exportImageFile: vi.fn() },
  },
}))

vi.mock('./Artifact', () => ({
  isRenderableCodeLanguage: () => false,
}))

import Markdown from './Markdown'

describe('Markdown server rendering', () => {
  it('colors novel dialogue across inline formatting without coloring narration, code or links', () => {
    const text = '他推开门。“别**回头**。”她说：\n\n「我在这里。」\n\n`“示例代码”` [“链接”](https://example.com)'
    const html = ReactDOMServer.renderToStaticMarkup(<Markdown novelDialogue>{text}</Markdown>)
    expect(html).toContain('他推开门。<span class="novel-dialogue">“别</span>')
    expect(html).toContain('<strong><span class="novel-dialogue">回头</span></strong>')
    expect(html).toContain('<span class="novel-dialogue">。”</span>她说：')
    expect(html).toContain('<span class="novel-dialogue">「我在这里。」</span>')
    expect(html).not.toContain('class="novel-dialogue">“示例代码”')
    expect(html).not.toContain('class="novel-dialogue">“链接”')
    expect(ReactDOMServer.renderToStaticMarkup(<Markdown>{text}</Markdown>)).not.toContain('novel-dialogue')
  })

  it('colors an unfinished streamed quotation without changing its text', () => {
    const html = ReactDOMServer.renderToStaticMarkup(<Markdown novelDialogue>{'风停了。“还没说完'}</Markdown>)
    expect(html).toContain('风停了。<span class="novel-dialogue">“还没说完</span>')
  })
  it('attaches source-stable identities to actual rendered Markdown blocks', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <Markdown uniqueId="message-0">{'First paragraph\n\nSecond paragraph'}</Markdown>
    )
    expect(html).toContain('data-transcript-block="message-0:0"')
    expect(html).toContain('data-transcript-block="message-0:17"')
  })

  it('keeps image rendering available to HTML exports without client providers', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <Markdown>{'![Exported image](https://example.com/exported.png)'}</Markdown>
    )

    expect(html).toContain('src="https://example.com/exported.png"')
    expect(html).toContain('alt="Exported image"')
  })
})
