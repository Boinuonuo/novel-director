import { beforeEach, describe, expect, it, vi } from 'vitest'
import { removeUntouchedExampleSessions } from './init_data'

const mocks = vi.hoisted(() => ({
  getSessionContextSource: vi.fn(),
  deleteSession: vi.fn(),
}))

vi.mock('@/app/renderer-application', () => ({
  rendererApplication: { sessions: { getSessionContextSource: mocks.getSessionContextSource } },
}))

vi.mock('@/stores/session/crud', () => ({ deleteSession: mocks.deleteSession }))

vi.mock('@/packages/initial_data', () => ({
  defaultSessionsForCN: [{ id: 'cn', messages: [{ id: 'm1' }] }],
  defaultSessionsForEN: [{ id: 'en', messages: [{ id: 'm1' }, { id: 'm2' }] }],
}))

describe('removeUntouchedExampleSessions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('removes an example conversation left as it was seeded', async () => {
    mocks.getSessionContextSource.mockImplementation(async ({ sessionId }) =>
      sessionId === 'en' ? { pathMessageIds: ['m1', 'm2'] } : null
    )
    await removeUntouchedExampleSessions()
    expect(mocks.deleteSession.mock.calls).toEqual([['en']])
  })

  it('keeps one the author has written in', async () => {
    mocks.getSessionContextSource.mockResolvedValue({ pathMessageIds: ['m1', 'm2', 'm3'] })
    await removeUntouchedExampleSessions()
    expect(mocks.deleteSession).not.toHaveBeenCalled()
  })

  it('leaves the conversations alone when one cannot be read', async () => {
    mocks.getSessionContextSource.mockRejectedValue(new Error('locked'))
    await expect(removeUntouchedExampleSessions()).resolves.toBeUndefined()
    expect(mocks.deleteSession).not.toHaveBeenCalled()
  })
})
