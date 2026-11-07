// @vitest-environment jsdom

import { expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import MessageErrTips from './MessageErrTips'

vi.mock('@mantine/core', () => ({ Text: ({ children }: { children: string }) => <span>{children}</span> }))
vi.mock('./GenericMessageError', () => ({ GenericMessageError: () => <div>generic error</div> }))
vi.mock('./message-error-presentation', () => ({
  resolveMessageErrorPresentation: (msg: { error?: string }) => ({
    kind: msg.error === 'old quota' ? 'quota' : 'generic',
  }),
}))

const message = (error?: string) => ({ id: 'm', role: 'assistant', contentParts: [], error }) as never

test('shows nothing for a message without an error', () => {
  render(<MessageErrTips msg={message()} />)
  expect(screen.queryByText('generic error')).toBeNull()
})

test('uses the shared error view', () => {
  render(<MessageErrTips msg={message('failed')} />)
  expect(screen.getByText('generic error')).toBeTruthy()
})

test('shows the plain text of an error from the old Chatbox service', () => {
  render(<MessageErrTips msg={message('old quota')} />)
  expect(screen.getByText('old quota')).toBeTruthy()
})
