import { UnstyledButton } from '@mantine/core'
import { IconBook2 } from '@tabler/icons-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { AppTooltip as Tooltip } from '@/components/ui/tooltip'
import platform from '@/platform'
import { setSessionNovelMode, useSessionNovelMode } from '@/stores/session/novel-mode'
import * as toastActions from '@/stores/toastActions'

/** The switch for the app's main mode, always in view next to the chat and work modes. */
export function NovelModeButton({
  sessionId,
  iconSize = 18,
  compact = false,
}: {
  sessionId: string
  iconSize?: number
  /** Small screens show the icon alone. */
  compact?: boolean
}) {
  const { t } = useTranslation()
  const enabled = useSessionNovelMode(sessionId)
  if (!platform.isDesktopLike) return null

  const label = t('Novel Mode')
  return (
    <Tooltip
      label={t(
        'One conversation is one novel. The background keeps track of the world, characters and foreshadowing, so a very long story stays consistent.'
      )}
      position="top"
      withArrow
    >
      <UnstyledButton
        data-testid="novel-mode-toggle"
        aria-label={label}
        aria-pressed={enabled}
        onClick={() => {
          setSessionNovelMode(sessionId, !enabled).catch(() => toastActions.add(t('Failed to save settings')))
        }}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 rounded-lg transition-colors',
          enabled
            ? 'bg-chatbox-background-brand-secondary text-chatbox-tint-brand'
            : 'text-chatbox-tint-secondary hover:bg-[var(--chatbox-background-tertiary)]'
        )}
      >
        <IconBook2 size={iconSize} strokeWidth={1.8} />
        {!compact && <span className="text-xs font-medium whitespace-nowrap">{label}</span>}
      </UnstyledButton>
    </Tooltip>
  )
}
