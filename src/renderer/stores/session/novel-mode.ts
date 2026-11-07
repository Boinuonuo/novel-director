import { rendererApplication } from '@/app/renderer-application'
import { uiStore, useUIStore } from '../uiStore'
import { setSessionAgentMode } from './agent-mode'
import { getNovelContextSource } from './novel-context-registry'

/** Whether a conversation is a novel. `new` is the chat about to be started. */
export function useSessionNovelMode(sessionId: string): boolean {
  const newChat = useUIStore((state) => state.newChatNovelMode)
  const { session } = rendererApplication.sessionHooks.useSessionHeader(sessionId === 'new' ? null : sessionId)
  return sessionId === 'new' ? newChat : session?.settings?.novelMode === true
}

/** Turn novel mode on or off. Writing a chapter needs no tools, so it leaves Work Mode. */
export async function setSessionNovelMode(sessionId: string, enabled: boolean): Promise<void> {
  if (enabled) await setSessionAgentMode(sessionId, 'off')
  if (sessionId === 'new') {
    uiStore.getState().setNewChatNovelMode(enabled)
    return
  }
  await rendererApplication.sessions.updateSessionHeader(sessionId, (session) => {
    if (!session) throw new Error('Session not found')
    return { ...session, settings: { ...session.settings, novelMode: enabled || undefined } }
  })
  if (enabled) getNovelContextSource()?.onChapterFinished?.(sessionId)
}
