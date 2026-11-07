import { describe, expect, it, vi } from 'vitest'
import { BLOCKED_REQUEST_URLS, blockChatboxHosts } from './block-chatbox-hosts'

describe('blockChatboxHosts', () => {
  it('cancels every request to the listed hosts', () => {
    const onBeforeRequest = vi.fn()
    blockChatboxHosts({ webRequest: { onBeforeRequest } } as never)

    const [filter, listener] = onBeforeRequest.mock.calls[0]
    expect(filter).toEqual({ urls: BLOCKED_REQUEST_URLS })
    const callback = vi.fn()
    listener({}, callback)
    expect(callback).toHaveBeenCalledWith({ cancel: true })
  })
})
