import fs from 'node:fs'
import path from 'node:path'
import { type Client, createClient } from '@libsql/client'
import { app, ipcMain } from 'electron'
import { getLogger } from '../util'

const log = getLogger('novel')

let initPromise: Promise<Client> | null = null

async function openDatabase(): Promise<Client> {
  const dbPath =
    process.env.NOVEL_DB_PATH || path.join(app.getPath('userData'), 'chatbox-databases', 'chatbox_novel.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const client = createClient({ url: `file:${dbPath}` })
  await client.execute('PRAGMA journal_mode=WAL')
  await client.execute('PRAGMA busy_timeout = 5000')
  await client.execute(`CREATE TABLE IF NOT EXISTS novel_record (
    session_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, record_id)
  )`)
  return client
}

/** Long-form records for one session, oldest first. The renderer owns their meaning. */
async function listRecords(sessionId: string): Promise<unknown[]> {
  const client = await getInitPromise()
  const result = await client.execute({
    sql: 'SELECT body FROM novel_record WHERE session_id = ? ORDER BY created_at, record_id',
    args: [sessionId],
  })
  return result.rows.map((row) => JSON.parse(String(row.body)))
}

async function putRecord(sessionId: string, record: { id: string; createdAt: number }): Promise<void> {
  const client = await getInitPromise()
  await client.execute({
    sql: `INSERT INTO novel_record (session_id, record_id, body, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (session_id, record_id) DO UPDATE SET body = excluded.body, created_at = excluded.created_at`,
    args: [sessionId, record.id, JSON.stringify(record), record.createdAt],
  })
}

async function deleteRecord(sessionId: string, recordId: string): Promise<void> {
  const client = await getInitPromise()
  await client.execute({
    sql: 'DELETE FROM novel_record WHERE session_id = ? AND record_id = ?',
    args: [sessionId, recordId],
  })
}

async function deleteSession(sessionId: string): Promise<void> {
  const client = await getInitPromise()
  await client.execute({ sql: 'DELETE FROM novel_record WHERE session_id = ?', args: [sessionId] })
}

export function getInitPromise(): Promise<Client> {
  if (!initPromise) {
    initPromise = openDatabase().catch((error) => {
      initPromise = null
      log.error('Failed to open the novel database:', error)
      throw error
    })
  }
  return initPromise
}

ipcMain.handle('novel:list-records', (_event, sessionId: string) => listRecords(sessionId))
ipcMain.handle('novel:put-record', (_event, sessionId: string, record: { id: string; createdAt: number }) =>
  putRecord(sessionId, record)
)
ipcMain.handle('novel:delete-record', (_event, sessionId: string, recordId: string) =>
  deleteRecord(sessionId, recordId)
)
ipcMain.handle('novel:delete-session', (_event, sessionId: string) => deleteSession(sessionId))
