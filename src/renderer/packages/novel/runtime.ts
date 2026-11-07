import {
  buildNovelSnapshot,
  foldNovelMemory,
  NovelArchivist,
  type NovelArchivistStatus,
  type NovelEditPatch,
  type NovelEditRecord,
  type NovelEditTarget,
  type NovelLedger,
  type NovelMemory,
  type NovelPendingRecord,
  type NovelRecord,
  type NovelResolution,
  pendingRecordId,
} from '@chatbox/core/novel'
import { createModel } from '@/adapters'
import { rendererApplication } from '@/app/renderer-application'
import { getLogger } from '@/lib/utils'
import { generateText } from '@/packages/model-calls'
import { selectBackgroundModel, worldThinkingOptions } from '@/packages/novel/world-model'
import { settingsService } from '@/settings-runtime'
import { setNovelContextSource } from '@/stores/session/novel-context-registry'

const log = getLogger('novel-runtime')

/** Below this many trailing unrecorded messages, the records still count as keeping up. */
const ALLOWED_UNRECORDED_MESSAGES = 8
/**
 * How long a request waits for the newest chapter's numbers. They are usually read
 * while the author is still reading the chapter; this only matters for a quick reply.
 */
const PENDING_WAIT_MS = 12_000

const records = new Map<string, NovelRecord[]>()

const invoke = (channel: string, ...args: unknown[]) =>
  (
    window as unknown as { electronAPI: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } }
  ).electronAPI.invoke(channel, ...args)

async function listRecords(sessionId: string): Promise<NovelRecord[]> {
  const cached = records.get(sessionId)
  if (cached) return cached
  const loaded = (await invoke('novel:list-records', sessionId)) as NovelRecord[]
  records.set(sessionId, loaded)
  return loaded
}

async function putRecord(sessionId: string, record: NovelRecord): Promise<void> {
  await invoke('novel:put-record', sessionId, record)
  const current = records.get(sessionId) ?? []
  records.set(sessionId, [...current.filter((item) => item.id !== record.id), record])
}

async function deleteRecord(sessionId: string, recordId: string): Promise<void> {
  await invoke('novel:delete-record', sessionId, recordId)
  const current = records.get(sessionId)
  if (current)
    records.set(
      sessionId,
      current.filter((item) => item.id !== recordId)
    )
}

async function readPath(sessionId: string): Promise<readonly string[] | null> {
  const source = await rendererApplication.sessions.getSessionContextSource({ sessionId, maxContextMessageCount: 1 })
  return source?.pathMessageIds ?? null
}

async function complete(prompt: string, role?: 'world'): Promise<{ text: string; model: string }> {
  const settings = settingsService.getSettings()
  const selection = selectBackgroundModel(settings, role)
  if (!selection) throw new Error('No background model is set')
  const model = await createModel({ ...settings, provider: selection.provider, modelId: selection.model })
  const providerOptions = role === 'world' ? worldThinkingOptions(selection) : undefined
  const result = await generateText(
    model,
    [{ id: 'novel-archivist', role: 'user', contentParts: [{ type: 'text', text: prompt }] }],
    { providerOptions }
  )
  const text = (result.contentParts ?? [])
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')
    .replace(/<think>.*?<\/think>/gs, '')
  return { text, model: selection.model }
}

const archivist = new NovelArchivist({
  async isEnabled(sessionId) {
    if (!settingsService.getSettings().novelArchivistModel) return false
    const read = await rendererApplication.sessions.getSessionHeader(sessionId)
    return read?.header.settings?.novelMode === true
  },
  async chapterHeadings(sessionId) {
    const read = await rendererApplication.sessions.getSessionHeader(sessionId)
    return read?.header.settings?.novelHeadings === true
  },
  readPath,
  async readMessages(sessionId, messageIds) {
    return (await rendererApplication.sessions.readSessionMessages({ sessionId, messageIds }))?.messages ?? []
  },
  listRecords,
  putRecord,
  deleteRecord,
  complete,
  schedule: (run, delayMs) => {
    setTimeout(run, delayMs)
  },
  now: Date.now,
  logError: (message, error) => log.error(message, error),
})

export function getNovelStatus(sessionId: string): NovelArchivistStatus {
  return archivist.getStatus(sessionId)
}

export function subscribeNovelStatus(listener: (sessionId: string) => void): () => void {
  return archivist.subscribe(listener)
}

/** Ask the background work to catch up, such as after the author turns long-form mode on. */
export function requestNovelCatchUp(sessionId: string): void {
  archivist.schedule(sessionId)
}

/** Go back over chapters recorded before numbers were kept. Costs one background call per chapter. */
export function requestNovelFactScan(sessionId: string): void {
  archivist.scanForFacts(sessionId)
}

export interface NovelMemoryView {
  memory: NovelMemory
  /** The numbers with the newest chapters' changes added on, and any conflicts in them. */
  ledger: NovelLedger
}

export async function readNovelMemory(sessionId: string): Promise<NovelMemoryView | null> {
  const path = await readPath(sessionId)
  if (!path) return null
  const { memory, ledger } = await archivist.readLedger(sessionId, path)
  return { memory, ledger }
}

const editId = (target: NovelEditTarget, key: string) => `edit:${target}:${key}`

/** Keep the author's change. Repeated edits of one entry merge into one record. */
export async function saveNovelEdit(
  sessionId: string,
  edit: { target: NovelEditTarget; key: string; action: 'update' | 'delete'; patch?: NovelEditPatch }
): Promise<void> {
  const id = editId(edit.target, edit.key)
  const stored = await listRecords(sessionId)
  const previous = stored.find((record): record is NovelEditRecord => record.kind === 'edit' && record.id === id)
  const path = (await readPath(sessionId)) ?? []
  // A number the author sets is the value after every chapter they could see, settled or not.
  const atChapter =
    edit.target === 'fact'
      ? (await archivist.readLedger(sessionId, path)).ledger.through
      : foldNovelMemory(stored, path).chapters.length
  await putRecord(sessionId, {
    kind: 'edit',
    id,
    ...edit,
    patch: { ...previous?.patch, ...edit.patch },
    atChapter,
    createdAt: Date.now(),
  })
  // An edited summary invalidates the paragraph condensed from it.
  requestNovelCatchUp(sessionId)
}

/** Take the ledger's side or the prose's where a chapter not yet settled disagrees with the numbers. */
export async function resolveNovelConflict(
  sessionId: string,
  conflict: { messageId: string; key: string },
  choice: NovelResolution
): Promise<void> {
  const id = pendingRecordId(conflict.messageId)
  const stored = (await listRecords(sessionId)).find(
    (record): record is NovelPendingRecord => record.kind === 'pending' && record.id === id
  )
  if (!stored) return
  await putRecord(sessionId, { ...stored, resolutions: { ...stored.resolutions, [conflict.key]: choice } })
}

/** Bring back something the author deleted. */
export async function restoreNovelItem(sessionId: string, target: NovelEditTarget, key: string): Promise<void> {
  const id = editId(target, key)
  const stored = await listRecords(sessionId)
  const edit = stored.find((record): record is NovelEditRecord => record.kind === 'edit' && record.id === id)
  // Keep an earlier rewrite of the entry, and let a paragraph that left out this summary be redone.
  if (edit && (target === 'chapter' || Object.keys(edit.patch ?? {}).length > 0)) {
    await putRecord(sessionId, { ...edit, action: 'update', createdAt: Date.now() })
    requestNovelCatchUp(sessionId)
    return
  }
  await invoke('novel:delete-record', sessionId, id)
  records.set(
    sessionId,
    stored.filter((record) => record.id !== id)
  )
}

/** Wire long-form support into the app. Desktop only: the records live in the main process. */
export function startNovelRuntime(): () => void {
  setNovelContextSource({
    async read(sessionId, pathMessageIds) {
      if (!pathMessageIds) return undefined
      // The newest chapter's numbers, read at once, so the writer does not have to add them up from the prose.
      await archivist.ensurePending(sessionId, PENDING_WAIT_MS)
      const { memory, ledger } = await archivist.readLedger(sessionId, pathMessageIds)
      return memory.chapters.length > 0 || ledger.facts.length > 0 ? buildNovelSnapshot(memory, ledger) : undefined
    },
    async coversHistory(sessionId) {
      const path = await readPath(sessionId)
      if (!path) return false
      const { chapters, coveredThroughMessageId } = foldNovelMemory(await listRecords(sessionId), path)
      if (chapters.length === 0 || !coveredThroughMessageId) return false
      return path.length - 1 - path.indexOf(coveredThroughMessageId) <= ALLOWED_UNRECORDED_MESSAGES
    },
    onChapterFinished: requestNovelCatchUp,
  })
  return rendererApplication.sessionEvents.subscribe(async (event) => {
    if (event.type !== 'session-deleted') return
    for (const id of event.ids) {
      records.delete(id)
      await invoke('novel:delete-session', id)
    }
  })
}
