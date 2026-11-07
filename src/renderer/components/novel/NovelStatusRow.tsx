import { Text, UnstyledButton } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import { novelStatusLine, openConflicts, useNovelMemory } from '@/components/novel/useNovelMemory'
import { useSessionNovelMode } from '@/stores/session/novel-mode'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'

function StatusLine({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const { memory, ledger, status } = useNovelMemory(sessionId)
  const hasModel = useSettingsStore((s) => Boolean(s.novelArchivistModel))
  const openSessionPanel = useUIStore((s) => s.openSessionPanel)
  const chapters = memory?.chapters.length ?? 0
  const hooks = memory?.openHooks.length ?? 0
  const conflicts = openConflicts(ledger).length

  if (hasModel && status.state === 'idle' && chapters === 0 && conflicts === 0) return null
  const line = hasModel ? novelStatusLine(t, status, chapters) : t('Choose a background model to start recording.')
  const failed = hasModel && status.state === 'failed'
  return (
    <UnstyledButton
      data-testid="novel-status"
      onClick={() => openSessionPanel(sessionId, 'novel')}
      className="self-start rounded px-1 transition-opacity hover:opacity-70"
    >
      <Text size="xs" c={failed ? 'chatbox-error' : 'chatbox-tertiary'}>
        {line}
        {hasModel && !failed && hooks > 0 && ` · ${t('{{count}} open threads', { count: hooks })}`}
        {hasModel && conflicts > 0 && (
          <Text span size="xs" c="chatbox-warning">
            {` · ${t('{{count}} numbers to check', { count: conflicts })}`}
          </Text>
        )}
      </Text>
    </UnstyledButton>
  )
}

/** A quiet line above the composer, so a stalled record is seen without opening the panel. */
export function NovelStatusRow({ sessionId }: { sessionId: string }) {
  const enabled = useSessionNovelMode(sessionId)
  return enabled ? <StatusLine sessionId={sessionId} /> : null
}
