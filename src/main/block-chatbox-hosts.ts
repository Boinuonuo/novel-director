import type { Session } from 'electron'

/** Every host of the Chatbox service, including its error reporting. */
export const BLOCKED_REQUEST_URLS = [
  '*://*.chatboxai.app/*',
  '*://*.chatboxai.com/*',
  '*://*.ai-chatbox.com/*',
  '*://*.chatboxapp.xyz/*',
  '*://*.midway.run/*',
]

/**
 * Nothing in this app should talk to Chatbox's servers. Code paths are cut one by one,
 * and this stops whatever is left, so a stray call fails instead of leaving the machine.
 */
export function blockChatboxHosts(session: Pick<Session, 'webRequest'>): void {
  session.webRequest.onBeforeRequest({ urls: BLOCKED_REQUEST_URLS }, (_details, callback) => {
    callback({ cancel: true })
  })
}
