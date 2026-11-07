import type { NovelArchivistStatus, NovelLedger, NovelMemory } from '@chatbox/core/novel'
import { useCallback, useEffect, useState } from 'react'
import { getNovelStatus, readNovelMemory, subscribeNovelStatus } from '@/packages/novel/runtime'

export function useNovelMemory(sessionId: string) {
  const [memory, setMemory] = useState<NovelMemory | null>(null)
  const [ledger, setLedger] = useState<NovelLedger | null>(null)
  const [status, setStatus] = useState<NovelArchivistStatus>(() => getNovelStatus(sessionId))

  const refresh = useCallback(() => {
    setStatus(getNovelStatus(sessionId))
    void readNovelMemory(sessionId).then(
      (view) => {
        setMemory(view?.memory ?? null)
        setLedger(view?.ledger ?? null)
      },
      () => {
        setMemory(null)
        setLedger(null)
      }
    )
  }, [sessionId])

  useEffect(() => {
    refresh()
    return subscribeNovelStatus((changed) => {
      if (changed === sessionId) refresh()
    })
  }, [refresh, sessionId])

  return { memory, ledger, status, refresh }
}

/** Disagreements between the prose and the numbers that the author has not looked at yet. */
export const openConflicts = (ledger: NovelLedger | null) =>
  ledger?.conflicts.filter((conflict) => !conflict.resolved) ?? []

export function novelStatusLine(
  t: (key: string, options?: Record<string, unknown>) => string,
  status: NovelArchivistStatus,
  chapters: number
) {
  if (status.state === 'failed') return t('Recording paused. It will try again after the next chapter.')
  if (status.state === 'running' && status.task === 'world') return t('Thinking through the world…')
  if (status.state === 'running') return t('Recording chapter {{count}}…', { count: status.chapters + 1 })
  return t('{{count}} chapters recorded', { count: chapters })
}
