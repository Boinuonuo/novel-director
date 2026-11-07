import { rendererApplication } from '@/app/renderer-application'
import { defaultSessionsForCN, defaultSessionsForEN } from '@/packages/initial_data'
import { deleteSession } from '@/stores/session/crud'

/**
 * Older profiles were seeded with Chatbox's example conversations. Remove the ones
 * still as they were seeded; a conversation the author has written in stays.
 */
export async function removeUntouchedExampleSessions() {
  for (const example of [...defaultSessionsForCN, ...defaultSessionsForEN]) {
    const source = await rendererApplication.sessions
      .getSessionContextSource({ sessionId: example.id, maxContextMessageCount: 1 })
      .catch(() => null)
    if (source && source.pathMessageIds.length <= example.messages.length) {
      await deleteSession(example.id)
    }
  }
}
