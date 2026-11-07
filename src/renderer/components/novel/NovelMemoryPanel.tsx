import {
  type NovelConflict,
  type NovelEditPatch,
  type NovelEditTarget,
  type NovelLedgerFact,
  type NovelResolution,
  splitTraits,
} from '@chatbox/core/novel'
import NiceModal from '@ebay/nice-modal-react'
import { Accordion, ActionIcon, Badge, Button, Stack, Text, Textarea } from '@mantine/core'
import type { SessionHeader } from '@shared/types'
import { IconPencil, IconTrash, IconX } from '@tabler/icons-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScalableIcon } from '@/components/common/ScalableIcon'
import { ModelSelectorV2 } from '@/components/ModelSelectorV2'
import { NovelHelp } from '@/components/novel/NovelHelp'
import { novelStatusLine, useNovelMemory } from '@/components/novel/useNovelMemory'
import {
  requestNovelCatchUp,
  requestNovelFactScan,
  resolveNovelConflict,
  restoreNovelItem,
  saveNovelEdit,
} from '@/packages/novel/runtime'
import { settingsStore, useSettingsStore } from '@/stores/settingsStore'
import * as toastActions from '@/stores/toastActions'

function Section({
  value,
  title,
  count,
  children,
}: {
  value: string
  title: string
  count: number
  children: ReactNode
}) {
  if (count === 0) return null
  return (
    <Accordion.Item value={value}>
      <Accordion.Control>
        <Text size="sm" fw={500}>
          {title}
          <Text span size="xs" c="chatbox-tertiary" ms={6}>
            {count}
          </Text>
        </Text>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack gap="sm">{children}</Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}

function Entry({ title, note, children }: { title?: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div>
      {title && (
        <Text size="sm" fw={500}>
          {title}
        </Text>
      )}
      {children}
      {note && (
        <Text size="xs" c="chatbox-tertiary" mt={2}>
          {note}
        </Text>
      )}
    </div>
  )
}

interface EntryField {
  name: string
  label?: ReactNode
  value: string
}

/** An entry the author can rewrite or delete. The controls stay out of sight until the pointer is on it. */
function EditableEntry({
  fields,
  onSave,
  onDelete,
  children,
}: {
  fields: EntryField[]
  /** Only the fields that changed, so an edit never pins what the author did not touch. */
  onSave: (changed: Record<string, string>) => void
  onDelete: () => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<string[] | null>(null)

  if (draft) {
    const save = () => {
      const changed = fields.filter((field, index) => draft[index].trim() !== field.value)
      if (changed.length > 0) {
        onSave(Object.fromEntries(changed.map((field) => [field.name, draft[fields.indexOf(field)].trim()])))
      }
      setDraft(null)
    }
    return (
      <Stack gap={6}>
        {fields.map((field, index) => (
          <Textarea
            key={field.name}
            label={field.label}
            size="xs"
            autosize
            minRows={1}
            value={draft[index]}
            onChange={(event) => {
              const next = [...draft]
              next[index] = event.currentTarget.value
              setDraft(next)
            }}
          />
        ))}
        <div className="flex justify-end gap-1">
          <Button variant="subtle" color="chatbox-secondary" size="compact-xs" onClick={() => setDraft(null)}>
            {t('Cancel')}
          </Button>
          <Button size="compact-xs" disabled={fields.length === 1 && !draft[0].trim()} onClick={save}>
            {t('Save')}
          </Button>
        </div>
      </Stack>
    )
  }

  return (
    <div className="group flex items-start gap-1">
      <div className="min-w-0 flex-1">{children}</div>
      <div className="flex shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <ActionIcon
          variant="subtle"
          color="chatbox-tertiary"
          size="sm"
          aria-label={t('Edit')}
          onClick={() => setDraft(fields.map((field) => field.value))}
        >
          <ScalableIcon icon={IconPencil} size={14} />
        </ActionIcon>
        <ActionIcon variant="subtle" color="chatbox-tertiary" size="sm" aria-label={t('Delete')} onClick={onDelete}>
          <ScalableIcon icon={IconTrash} size={14} />
        </ActionIcon>
      </div>
    </div>
  )
}

/** Where a chapter not yet settled disagrees with the numbers. The author picks a side; until then a default holds. */
function ConflictNotice({
  conflict,
  onChoose,
}: {
  conflict: NovelConflict
  onChoose: (choice: NovelResolution) => void
}) {
  const { t } = useTranslation()
  const what =
    conflict.kind === 'anchor'
      ? conflict.name
      : t("{{owner}}'s {{name}}", { owner: conflict.owner || t('Protagonist'), name: conflict.name })
  const values = { chapter: conflict.chapter, what, expected: conflict.expected, claimed: conflict.claimed }
  const text =
    conflict.kind === 'sum'
      ? t('Chapter {{chapter}} says {{what}} is {{claimed}}, but {{previous}} {{change}} makes {{expected}}.', {
          ...values,
          previous: conflict.previous,
          change: conflict.change,
        })
      : conflict.kind === 'jump'
        ? t('Chapter {{chapter}} changes {{what}} from {{expected}} to {{claimed}} without saying why.', values)
        : t('Chapter {{chapter}} gives {{what}} as {{claimed}}, but the world had {{expected}}.', values)
  const choice = (side: NovelResolution, label: string) => (
    <Button
      size="compact-xs"
      variant={conflict.chosen === side ? 'light' : 'subtle'}
      color={conflict.chosen === side ? undefined : 'chatbox-secondary'}
      onClick={() => onChoose(side)}
    >
      {label}
    </Button>
  )
  return (
    <div className="rounded-md bg-[var(--chatbox-background-warning-secondary)] px-2 py-1.5">
      <Text size="xs">{text}</Text>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {choice('ledger', t('Ledger: {{value}}', { value: conflict.expected }))}
        {choice('prose', t('Text: {{value}}', { value: conflict.claimed }))}
      </div>
    </div>
  )
}

/** Where a number came from: the settled value, then each newer chapter's change. */
function factNote(t: (key: string, options?: Record<string, unknown>) => string, fact: NovelLedgerFact) {
  if (fact.inferred) return t('Worked out from: {{basis}}', { basis: fact.basis })
  if (fact.pending.length > 0) {
    const steps = [
      ...(fact.settled ? [{ chapter: fact.settled.chapter, change: fact.settled.value }] : []),
      ...fact.pending.map((step) => ({ chapter: step.chapter, change: step.change || step.value })),
    ]
    return steps.map((step) => t('Chapter {{chapter}}: {{change}}', step)).join(' → ')
  }
  return fact.change
    ? t('Chapter {{chapter}}: {{change}}', { chapter: fact.chapter, change: fact.change })
    : t('Chapter {{chapter}}', { chapter: fact.chapter })
}

function ModelRow({
  label,
  help,
  selection,
  placeholder,
  onSelect,
  onClear,
}: {
  label: string
  help: string
  selection?: { provider: string; model: string }
  placeholder: string
  onSelect: (selection: { provider: string; model: string }) => void
  onClear?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <Text size="sm">{label}</Text>
      <NovelHelp label={help} />
      <div className="ms-auto flex items-center gap-1">
        <ModelSelectorV2
          position="bottom-end"
          width={320}
          selectedProviderId={selection?.provider}
          selectedModelId={selection?.model}
          searchPosition="top"
          onSelect={(provider, model) => {
            if (provider && model) onSelect({ provider, model })
          }}
        >
          <Button variant="subtle" size="compact-sm">
            {selection?.model ?? placeholder}
          </Button>
        </ModelSelectorV2>
        {onClear && selection && (
          <ActionIcon variant="subtle" color="chatbox-tertiary" size="sm" aria-label={t('Clear')} onClick={onClear}>
            <ScalableIcon icon={IconX} size={14} />
          </ActionIcon>
        )}
      </div>
    </div>
  )
}

function ModelPickers({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const archivist = useSettingsStore((s) => s.novelArchivistModel)
  const world = useSettingsStore((s) => s.novelWorldModel)
  const setSettings = (patch: Parameters<ReturnType<typeof settingsStore.getState>['setSettings']>[0]) =>
    settingsStore.getState().setSettings(patch)
  return (
    <Stack gap="xs">
      <ModelRow
        label={t('Background model')}
        help={t('Records every chapter faithfully. A cheap, fast model is enough.')}
        selection={archivist}
        placeholder={t('Choose a model')}
        onSelect={(selection) => {
          setSettings({ novelArchivistModel: selection })
          requestNovelCatchUp(sessionId)
        }}
      />
      {archivist && (
        <ModelRow
          label={t('World model')}
          help={t(
            'Thinks through prices, ranks and power so the world stays coherent. It runs every few chapters with thinking on, so a stronger model pays off here.'
          )}
          selection={world}
          placeholder={t('Same as background model')}
          onSelect={(selection) => setSettings({ novelWorldModel: selection })}
          onClear={() => setSettings({ novelWorldModel: undefined })}
        />
      )}
    </Stack>
  )
}

/**
 * What the background work remembers about this story. Nothing here needs upkeep, but
 * the author has the last word on all of it: any entry can be rewritten or deleted.
 */
export function NovelMemoryPanel({ session }: { session: SessionHeader }) {
  const { t } = useTranslation()
  const { memory, ledger, status, refresh } = useNovelMemory(session.id)
  const hasModel = useSettingsStore((s) => Boolean(s.novelArchivistModel))
  const segments = [...(memory?.segments ?? [])].reverse()
  const facts = ledger?.facts ?? []
  const conflicts = ledger?.conflicts ?? []
  const factGroups = [
    ...[...new Set(facts.filter((fact) => fact.kind === 'state').map((fact) => fact.owner))].map((owner) => ({
      title: owner || t('Protagonist'),
      facts: facts.filter((fact) => fact.kind === 'state' && fact.owner === owner),
    })),
    { title: t('World reference'), facts: facts.filter((fact) => fact.kind === 'anchor') },
  ].filter((group) => group.facts.length > 0)

  const apply = (work: Promise<void>) => {
    work.catch((error) => toastActions.add(error instanceof Error ? error.message : String(error))).finally(refresh)
  }
  const update = (target: NovelEditTarget, key: string, patch: NovelEditPatch) =>
    apply(saveNovelEdit(session.id, { target, key, action: 'update', patch }))
  const remove = (target: NovelEditTarget, key: string, label = key) => {
    const preview = label.replace(/\s+/g, ' ').trim()
    void NiceModal.show('confirm', {
      title: t('Delete this record?'),
      message: t(
        'Remove “{{entry}}” from story memory? It will no longer be used for writing. You can restore it under Deleted.',
        { entry: preview.length > 120 ? `${preview.slice(0, 120)}…` : preview }
      ),
      confirmText: t('Delete'),
      cancelText: t('Cancel'),
      danger: true,
      onConfirm: () => apply(saveNovelEdit(session.id, { target, key, action: 'delete' })),
    })
  }

  return (
    <Stack gap="md" p="md">
      <ModelPickers sessionId={session.id} />
      {hasModel && (
        <div className="flex items-center gap-1">
          <Text size="xs" c={status.state === 'failed' ? 'chatbox-error' : 'chatbox-tertiary'}>
            {novelStatusLine(t, status, memory?.chapters.length ?? 0)}
          </Text>
          <NovelHelp
            label={t(
              'A chapter is recorded about two replies after it is written, so what you rejected, ignored or changed stays out. You can rewrite or delete anything here, and the background will not change it back.'
            )}
          />
        </div>
      )}
      {hasModel && memory && memory.unscannedChapters > 0 && (
        <div className="flex items-center gap-1">
          <Button
            variant="light"
            size="compact-xs"
            disabled={status.state === 'running'}
            onClick={() => requestNovelFactScan(session.id)}
          >
            {t('Collect numbers from {{count}} earlier chapters', { count: memory.unscannedChapters })}
          </Button>
          <NovelHelp label={t('Reads those chapters again with the background model, one call per chapter.')} />
        </div>
      )}
      {memory && (memory.chapters.length > 0 || facts.length > 0) ? (
        <Accordion multiple defaultValue={['facts', 'characters', 'hooks']} variant="default" chevronPosition="right">
          <Section value="facts" title={t('Numbers')} count={facts.length}>
            {conflicts.length > 0 && (
              <Stack gap={6}>
                <div className="flex items-center gap-1">
                  <Text size="xs" c="chatbox-tertiary">
                    {t('To check')}
                  </Text>
                  <NovelHelp
                    label={t(
                      'A chapter that has not settled yet disagrees with the numbers. Until you choose, a balance that does not add up follows the ledger, and an amount that changes without a reason follows the text.'
                    )}
                  />
                </div>
                {conflicts.map((conflict) => (
                  <ConflictNotice
                    key={`${conflict.messageId}:${conflict.key}`}
                    conflict={conflict}
                    onChoose={(choice) => apply(resolveNovelConflict(session.id, conflict, choice))}
                  />
                ))}
              </Stack>
            )}
            {factGroups.map((group) => (
              <Stack key={group.title} gap={6}>
                <Text size="xs" c="chatbox-tertiary">
                  {group.title}
                </Text>
                {group.facts.map((fact) => (
                  <EditableEntry
                    key={fact.key}
                    fields={[{ name: 'text', value: fact.value }]}
                    onSave={({ text }) => update('fact', fact.key, { text })}
                    onDelete={() => remove('fact', fact.key, `${fact.owner} ${fact.name}：${fact.value}`)}
                  >
                    <Entry note={factNote(t, fact)}>
                      <Text size="sm">
                        <Text span size="sm" c="chatbox-secondary" me={6}>
                          {fact.name}
                        </Text>
                        {fact.value}
                        {fact.inferred && (
                          <Badge variant="light" size="xs" ms={6}>
                            {t('Inferred')}
                          </Badge>
                        )}
                        {fact.pending.length > 0 && (
                          <Badge variant="light" color="chatbox-secondary" size="xs" ms={6}>
                            {t('Unconfirmed')}
                          </Badge>
                        )}
                      </Text>
                    </Entry>
                  </EditableEntry>
                ))}
              </Stack>
            ))}
          </Section>
          <Section value="characters" title={t('Characters')} count={memory.characters.length}>
            {memory.characters.map((character) => (
              <EditableEntry
                key={character.name}
                fields={[
                  { name: 'status', label: t('Current state'), value: character.status },
                  { name: 'traits', label: t('Personality'), value: character.traits.join('、') },
                  { name: 'speech', label: t('Way of speaking'), value: character.speech },
                ]}
                onSave={({ traits, ...rest }) =>
                  update('character', character.name, {
                    ...rest,
                    ...(traits === undefined ? {} : { traits: splitTraits(traits) }),
                  })
                }
                onDelete={() => remove('character', character.name)}
              >
                <Entry title={character.name} note={character.arc.join(' → ') || undefined}>
                  {character.status && <Text size="xs">{character.status}</Text>}
                  {character.traits.length > 0 && (
                    <Text size="xs" c="chatbox-secondary">
                      {character.traits.join('、')}
                    </Text>
                  )}
                </Entry>
              </EditableEntry>
            ))}
          </Section>
          <Section value="hooks" title={t('Foreshadowing')} count={memory.openHooks.length}>
            {memory.openHooks.map((hook) => (
              <EditableEntry
                key={hook.id}
                fields={[{ name: 'text', value: hook.text }]}
                onSave={({ text }) => update('hook', hook.id, { text })}
                onDelete={() => remove('hook', hook.id, hook.text)}
              >
                <Entry note={`「${hook.quote}」`}>
                  <Text size="sm">{hook.text}</Text>
                </Entry>
              </EditableEntry>
            ))}
          </Section>
          <Section value="terms" title={t('Terms')} count={memory.terms.length}>
            {memory.terms.map((term) => (
              <EditableEntry
                key={term.name}
                fields={[{ name: 'text', value: term.description }]}
                onSave={({ text }) => update('term', term.name, { text })}
                onDelete={() => remove('term', term.name)}
              >
                <Entry title={term.name}>
                  <Text size="xs" c="chatbox-secondary">
                    {term.description}
                  </Text>
                </Entry>
              </EditableEntry>
            ))}
          </Section>
          <Section value="story" title={t('Story so far')} count={segments.length}>
            {segments.map((segment) => (
              <EditableEntry
                key={segment.key}
                fields={[{ name: 'text', value: segment.summary }]}
                onSave={({ text }) => update(segment.target, segment.key, { text })}
                onDelete={() => remove(segment.target, segment.key, segment.summary)}
              >
                <Text size="xs" c="chatbox-secondary">
                  {segment.text}
                </Text>
              </EditableEntry>
            ))}
          </Section>
          <Section value="changes" title={t('Corrected by the background')} count={memory.changes.length}>
            {memory.changes.map((change, index) => (
              <Entry key={`${change.chapter}:${index}`} title={change.label} note={change.reason}>
                <Text size="xs" c="chatbox-secondary">
                  {change.action === 'drop' ? t('Dropped') : t('Changed to: {{value}}', { value: change.value })}
                </Text>
              </Entry>
            ))}
          </Section>
          <Section value="deleted" title={t('Deleted')} count={memory.deleted.length}>
            {memory.deleted.map((item) => (
              <div key={`${item.target}:${item.key}`} className="flex items-center gap-2">
                <Text size="xs" c="chatbox-secondary" className="min-w-0 flex-1">
                  {item.label}
                </Text>
                <Button
                  variant="subtle"
                  size="compact-xs"
                  onClick={() => apply(restoreNovelItem(session.id, item.target, item.key))}
                >
                  {t('Restore')}
                </Button>
              </div>
            ))}
          </Section>
        </Accordion>
      ) : (
        <Text size="sm" c="chatbox-tertiary" ta="center" py="xl">
          {hasModel
            ? t('Records appear here about two replies after a chapter, once it has settled.')
            : t('Choose a background model to start recording.')}
        </Text>
      )}
    </Stack>
  )
}
