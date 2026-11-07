import { Text } from '@mantine/core'
import type { Message } from '@shared/types'
import { GenericMessageError } from './GenericMessageError'
import { resolveMessageErrorPresentation } from './message-error-presentation'

export default function MessageErrTips(props: {
  msg: Message
  sessionId?: string
  onRetry?: () => void | Promise<void>
}) {
  const { msg, onRetry } = props
  const presentation = resolveMessageErrorPresentation(msg, {})

  if (!msg.error) return null
  // These two came from Chatbox's own service, so a message that still has one just shows its text.
  if (presentation.kind === 'quota' || presentation.kind === 'agent-mode-reward') {
    return (
      <Text size="sm" c="chatbox-error">
        {msg.error}
      </Text>
    )
  }
  return <GenericMessageError msg={msg} presentation={presentation} onRetry={onRetry} />
}
