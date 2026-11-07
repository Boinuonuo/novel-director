import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>() }))

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler),
  },
}))
vi.mock('../util', () => ({ getLogger: () => ({ error: vi.fn(), info: vi.fn() }) }))

const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args)

describe('novel records', () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-db-'))
    process.env.NOVEL_DB_PATH = path.join(dir, 'novel.db')
    await import('./index')
  })

  it('stores records per session and returns them oldest first', async () => {
    await call('novel:put-record', 's1', { id: 'b', createdAt: 2, note: '第二章' })
    await call('novel:put-record', 's1', { id: 'a', createdAt: 1, note: '第一章' })
    await call('novel:put-record', 's2', { id: 'a', createdAt: 1, note: '另一部小说' })

    expect(await call('novel:list-records', 's1')).toEqual([
      { id: 'a', createdAt: 1, note: '第一章' },
      { id: 'b', createdAt: 2, note: '第二章' },
    ])
  })

  it('replaces a record with the same id', async () => {
    await call('novel:put-record', 's3', { id: 'a', createdAt: 1, note: '旧' })
    await call('novel:put-record', 's3', { id: 'a', createdAt: 2, note: '新' })
    expect(await call('novel:list-records', 's3')).toEqual([{ id: 'a', createdAt: 2, note: '新' }])
  })

  it('deletes only the named session', async () => {
    await call('novel:put-record', 's4', { id: 'a', createdAt: 1 })
    await call('novel:put-record', 's4', { id: 'b', createdAt: 2 })
    await call('novel:delete-record', 's4', 'a')
    expect(await call('novel:list-records', 's4')).toEqual([{ id: 'b', createdAt: 2 }])

    await call('novel:delete-session', 's1')
    expect(await call('novel:list-records', 's1')).toEqual([])
    expect(await call('novel:list-records', 's2')).toHaveLength(1)
  })
})
