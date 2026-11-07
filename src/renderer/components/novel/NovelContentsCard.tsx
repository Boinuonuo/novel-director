import { IconBook2, IconChevronDown } from '@tabler/icons-react'
import { useAtomValue } from 'jotai'
import { memo, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rendererApplication } from '@/app/renderer-application'
import { ScalableIcon } from '@/components/common/ScalableIcon'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import { createNovelContentsReader, type NovelChapterLink } from '@/packages/novel/contents'
import { currentSessionIdAtom } from '@/stores/atoms/sessionAtoms'
import { add as addToast } from '@/stores/toastActions'
import { uiStore } from '@/stores/uiStore'
import './novel-contents.css'

export function NovelContentsSidebar() {
  const sessionId = useAtomValue(currentSessionIdAtom)
  const { session } = rendererApplication.sessionHooks.useSessionHeader(sessionId)
  return session?.settings?.novelMode ? <NovelContentsCard key={session.id} sessionId={session.id} /> : null
}

export const NovelContentsCard = memo(function NovelContentsCard({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const isSmallScreen = useIsSmallScreen()
  const [expanded, setExpanded] = useState(true)
  const [chapters, setChapters] = useState<NovelChapterLink[]>([])
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: title caches must reset when this card changes novels.
  const reader = useMemo(() => createNovelContentsReader(rendererApplication.sessions), [sessionId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry intentionally restarts a failed scan.
  useEffect(() => {
    let request: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const load = async () => {
      request?.abort()
      const current = new AbortController()
      request = current
      setLoading(true)
      try {
        const entries = await reader.read(sessionId, current.signal)
        if (!disposed && !current.signal.aborted) {
          setChapters(entries)
          setFailed(false)
        }
      } catch {
        if (!disposed && !current.signal.aborted) setFailed(true)
      } finally {
        if (!disposed && !current.signal.aborted) setLoading(false)
        if (request === current) request = undefined
      }
    }
    if (expanded) void load()
    const stop = rendererApplication.sessionEvents.subscribe((event) => {
      if (event.type !== 'session-command-committed' || event.delta.sessionId !== sessionId) return
      const changed = reader.acceptDelta(event.delta)
      // An in-flight revision-bound read must restart after any concurrent commit.
      if (!changed && !request) return
      request?.abort()
      // Coalesce commits in this task, without waiting for generation to go quiet.
      if (expanded && !timer)
        timer = setTimeout(() => {
          timer = undefined
          void load()
        }, 0)
    })
    return () => {
      disposed = true
      request?.abort()
      clearTimeout(timer)
      stop()
    }
  }, [sessionId, expanded, retry, reader])

  return (
    <section className="novel-toc-card" aria-label={t('Table of contents') ?? undefined}>
      <button
        type="button"
        className="novel-toc-toggle"
        aria-expanded={expanded}
        aria-controls={`novel-toc-${sessionId}`}
        onClick={() => setExpanded((value) => !value)}
      >
        <ScalableIcon icon={IconBook2} size={17} />
        <span className="flex-1 text-start">{t('Table of contents')}</span>
        <span className="novel-toc-count">{loading && chapters.length === 0 ? '…' : chapters.length}</span>
        <ScalableIcon icon={IconChevronDown} size={14} className={expanded ? '' : '-rotate-90'} />
      </button>
      {expanded && (
        <div id={`novel-toc-${sessionId}`} className="novel-toc-body" aria-busy={loading}>
          {failed ? (
            <button type="button" className="novel-toc-empty" onClick={() => setRetry((value) => value + 1)}>
              {t('Could not load chapters. Click to retry.')}
            </button>
          ) : chapters.length === 0 ? (
            <p className="novel-toc-empty">{loading ? t('Loading chapters…') : t('Your chapters will appear here.')}</p>
          ) : (
            <nav aria-label={t('Chapters') ?? undefined}>
              <ol>
                {chapters.map((chapter, index) => (
                  <li key={chapter.messageId}>
                    <button
                      type="button"
                      className="novel-toc-chapter"
                      aria-current={selected === chapter.messageId ? 'location' : undefined}
                      title={chapter.title}
                      onClick={() => {
                        setSelected(chapter.messageId)
                        const navigation = uiStore.getState().transcriptNavigation
                        if (navigation?.sessionId !== sessionId) return
                        void navigation
                          .navigateMessage(chapter.messageId)
                          .catch(() => addToast(t('Could not open this chapter.')))
                        // Close only the temporary drawer; leave the desktop contents in view.
                        if (isSmallScreen) uiStore.getState().setShowSidebar(false)
                      }}
                    >
                      <span className="novel-toc-number" aria-hidden>
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="novel-toc-title">{chapter.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </div>
      )}
    </section>
  )
})
