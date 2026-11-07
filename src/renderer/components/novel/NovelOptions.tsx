import { extractTrailingOptions } from '@chatbox/core/novel'
import { UnstyledButton } from '@mantine/core'
import { useMemo } from 'react'
import { useUIStore } from '@/stores/uiStore'

/**
 * The options the latest chapter ends with, one click from the composer. A click adds
 * to the reply instead of sending it, so options can be combined or built on.
 */
export function NovelOptions({ text }: { text: string }) {
  const options = useMemo(() => extractTrailingOptions(text), [text])
  const setQuote = useUIStore((state) => state.setQuote)
  if (options.length === 0) return null
  return (
    <div data-testid="novel-options" className="mt-3 flex flex-wrap gap-2">
      {options.map((option) => (
        <UnstyledButton
          key={option}
          onClick={() => setQuote(option)}
          className="max-w-full rounded-full border border-solid border-chatbox-border-primary px-3 py-1 text-xs text-chatbox-tint-secondary transition-colors hover:bg-chatbox-background-secondary"
        >
          <span className="line-clamp-1">{option}</span>
        </UnstyledButton>
      ))}
    </div>
  )
}
