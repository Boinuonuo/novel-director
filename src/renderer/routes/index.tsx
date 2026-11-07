import { NOVEL_DEFAULT_PROMPT } from '@chatbox/core/novel'
import NiceModal from '@ebay/nice-modal-react'
import { Button, Stack, Text } from '@mantine/core'
import { getDefaultPrompt } from '@shared/defaults'
import { createMessage, type Message, type SessionHeader, type SessionSettings } from '@shared/types'
import { createFileRoute } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { rendererApplication } from '@/app/renderer-application'
import InputBox, { type InputBoxPayload } from '@/components/InputBox/InputBox'
import HomepageIcon from '@/components/icons/HomepageIcon'
import Page from '@/components/layout/Page'
import { navigateToSettings } from '@/modals/settings-navigation'
import { useProviders } from '@/hooks/useProviders'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import { resolveChatboxLicenseDefaultModel } from '@/stores/defaultChatModel'
import { lastUsedModelStore } from '@/stores/lastUsedModelStore'
import { getSessionAgentModeEntry } from '@/stores/session/agent-mode'
import { switchCurrentSession } from '@/stores/session/crud'
import { submitNewUserMessage } from '@/stores/session/messages'
import { settingsStore, useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'

export const Route = createFileRoute('/')({
  component: Index,
  validateSearch: zodValidator(
    z.object({
      copilotId: z.string().optional(),
      copilot: z.string().optional(),
      settings: z.string().optional(),
      folderId: z.string().optional(),
    })
  ),
})

function Index() {
  const { t } = useTranslation()
  const isSmallScreen = useIsSmallScreen()
  const { folderId } = Route.useSearch()

  const newSessionState = useUIStore((s) => s.newSessionState)
  const setNewSessionState = useUIStore((s) => s.setNewSessionState)
  const addSessionKnowledgeBase = useUIStore((s) => s.addSessionKnowledgeBase)
  const sessionWebBrowsingMap = useUIStore((s) => s.sessionWebBrowsingMap)
  const newSessionWebBrowsingDefault = useUIStore((s) => s.newSessionWebBrowsingDefault)
  const newSessionCommandApprovalModeDefault = useUIStore((s) => s.newSessionCommandApprovalModeDefault)
  const newSessionWorkingDirectoriesDefault = useUIStore((s) => s.newSessionWorkingDirectoriesDefault)
  const setSessionWebBrowsing = useUIStore((s) => s.setSessionWebBrowsing)
  const clearSessionWebBrowsing = useUIStore((s) => s.clearSessionWebBrowsing)
  const sessionAgentModeMap = useUIStore((s) => s.sessionAgentModeMap)
  const clearSessionAgentMode = useUIStore((s) => s.clearSessionAgentMode)
  const [session, setSession] = useState<SessionHeader>(() => {
    const settings = settingsStore.getState().getSettings()
    const model = settings.defaultChatModel
      ? { provider: settings.defaultChatModel.provider, modelId: settings.defaultChatModel.model }
      : lastUsedModelStore.getState().chat || resolveChatboxLicenseDefaultModel(settings)
    return { id: 'new', name: 'Untitled', type: 'chat', threadName: '', settings: { ...model } }
  })
  const [systemPrompt, setSystemPrompt] = useState(() => settingsStore.getState().defaultPrompt || '')
  const { providers } = useProviders()
  const defaultChatModel = useSettingsStore((s) => s.defaultChatModel)
  const licenseKey = useSettingsStore((s) => s.licenseKey)
  const licenseDetail = useSettingsStore((s) => s.licenseDetail)
  const licensePlanName = useSettingsStore((s) => s.licensePlanName)
  const hasExpiredLicense = useSettingsStore((s) => s.hasExpiredLicense)
  const selectedModel = useMemo(() => {
    if (session.settings?.provider && session.settings?.modelId) {
      return {
        provider: session.settings.provider,
        modelId: session.settings.modelId,
      }
    }
  }, [session.settings?.provider, session.settings?.modelId])

  useEffect(() => {
    setSession((old) => {
      if (old.settings?.provider && old.settings?.modelId) {
        return old
      }
      const defaultModel = defaultChatModel
        ? {
            provider: defaultChatModel.provider,
            modelId: defaultChatModel.model,
          }
        : resolveChatboxLicenseDefaultModel({
            licenseKey,
            hasExpiredLicense,
            licenseDetail,
            licensePlanName,
          })
      if (!defaultModel) {
        return old
      }
      return {
        ...old,
        settings: {
          ...(old.settings || {}),
          ...defaultModel,
        },
      }
    })
  }, [defaultChatModel, hasExpiredLicense, licenseDetail, licenseKey, licensePlanName])

  const novelMode = useUIStore((s) => s.newChatNovelMode)

  const createPersistedChatSession = useCallback(
    async (options?: {
      name?: string
      threadName?: string
      messages?: Message[]
      settingsPatch?: Partial<SessionSettings>
      settingsOverride?: Partial<SessionSettings>
    }) => {
      // Transient choices made while the chat was "new" win; otherwise new chats
      // continue the last explicit choice remembered from any earlier chat.
      const effectiveApprovalMode = newSessionState.commandApprovalMode ?? newSessionCommandApprovalModeDefault
      const effectiveWorkingDirectories = newSessionState.workingDirectories ?? newSessionWorkingDirectoriesDefault
      // A prompt set for this one chat stands; otherwise a novel starts from the novel prompt.
      const settings = settingsStore.getState()
      const untouched = [settings.defaultPrompt ?? '', getDefaultPrompt(), ''].includes(systemPrompt.trim())
      const usesNovelPrompt = novelMode && untouched
      const prompt = usesNovelPrompt ? settings.novelDefaultPrompt?.trim() || NOVEL_DEFAULT_PROMPT : systemPrompt
      const newSession = await rendererApplication.sessions.createSession(
        {
          name: options?.name ?? session.name,
          type: 'chat',
          folderId,
          assistantAvatarKey: session.assistantAvatarKey,
          picUrl: session.picUrl,
          backgroundImage: session.backgroundImage,
          messages: options?.messages ?? (prompt ? [createMessage('system', prompt)] : []),
          copilotId: session.copilotId,
          threadName: options?.threadName ?? session.threadName ?? '',
          settings: {
            ...session.settings,
            ...options?.settingsPatch,
            // Bake the exact mode shown while the chat was "new" into the created session, so
            // remembered defaults and transient selections follow the same resolution path.
            agentMode: novelMode
              ? { value: 'off', locked: false, lockReason: null }
              : getSessionAgentModeEntry('new', undefined, sessionAgentModeMap),
            ...(novelMode ? { novelMode: true, novelHeadings: usesNovelPrompt } : {}),
            ...(newSessionState.localWorkCapabilities !== undefined
              ? { localWorkCapabilities: newSessionState.localWorkCapabilities }
              : {}),
            // Working directories bound while the chat was still "new" (not yet persisted),
            // falling back to the remembered default from earlier chats.
            ...(effectiveWorkingDirectories?.length ? { workingDirectories: effectiveWorkingDirectories } : {}),
            ...(effectiveApprovalMode
              ? {
                  commandApprovalMode: effectiveApprovalMode,
                  // Keep the legacy flag in lockstep for older readers.
                  ...(effectiveApprovalMode === 'full_access' ? { agentFullAccess: true } : {}),
                }
              : newSessionState.agentFullAccess
                ? { agentFullAccess: true }
                : {}),
            ...options?.settingsOverride,
          },
        },
        undefined,
        { copilotName: session.copilotId ? session.name : undefined }
      )

      // Transfer knowledge base / Work Mode settings from newSessionState to the actual
      // session, then clear it so nothing bleeds into the next new chat. (workingDirectories
      // and the command approval policy are already baked into the created session's settings above;
      // this only clears them.)
      if (newSessionState.knowledgeBase) {
        addSessionKnowledgeBase(newSession.id, newSessionState.knowledgeBase)
      }
      if (
        newSessionState.localWorkCapabilities !== undefined ||
        newSessionState.knowledgeBase ||
        newSessionState.workingDirectories !== undefined ||
        newSessionState.agentFullAccess ||
        newSessionState.commandApprovalMode
      ) {
        setNewSessionState({})
      }

      // Transfer either the transient choice or the remembered new-chat default.
      // Clearing only removes the transient "new" slot; the remembered default remains.
      const newSessionWebBrowsing = sessionWebBrowsingMap.new ?? newSessionWebBrowsingDefault
      if (newSessionWebBrowsing !== undefined) {
        setSessionWebBrowsing(newSession.id, newSessionWebBrowsing)
        clearSessionWebBrowsing('new')
      }

      // Transfer agent mode setting from "new" session to the actual session
      if (sessionAgentModeMap.new) {
        clearSessionAgentMode('new')
      }

      switchCurrentSession(newSession.id)
      localStorage.removeItem('new-chat')

      return newSession
    },
    [
      session,
      systemPrompt,
      novelMode,
      folderId,
      addSessionKnowledgeBase,
      newSessionState.localWorkCapabilities,
      newSessionState.knowledgeBase,
      newSessionState.workingDirectories,
      newSessionState.agentFullAccess,
      newSessionState.commandApprovalMode,
      newSessionCommandApprovalModeDefault,
      newSessionWorkingDirectoriesDefault,
      setNewSessionState,
      sessionWebBrowsingMap,
      newSessionWebBrowsingDefault,
      setSessionWebBrowsing,
      clearSessionWebBrowsing,
      sessionAgentModeMap,
      clearSessionAgentMode,
    ]
  )

  const handleSubmit = useCallback(
    async ({ constructedMessage, needGenerating = true, onUserMessageReady, settingsPatch }: InputBoxPayload) => {
      const newSession = await createPersistedChatSession({ settingsPatch })

      void submitNewUserMessage(newSession.id, {
        newUserMsg: constructedMessage,
        needGenerating,
        onUserMessageReady,
      })
    },
    [createPersistedChatSession]
  )

  const onSelectModel = useCallback((p: string, m: string) => {
    setSession((old) => ({
      ...old,
      settings: {
        ...(old.settings || {}),
        provider: p,
        modelId: m,
      },
    }))
  }, [])

  const onClickSessionSettings = useCallback(async () => {
    const res: { session: SessionHeader; systemPrompt: string } | undefined = await NiceModal.show('session-settings', {
      session,
      systemPrompt,
    })
    if (res) {
      setSession(res.session)
      setSystemPrompt(res.systemPrompt)
    }
    return true
  }, [session, systemPrompt])

  return (
    <Page title="">
      <div className="p-0 flex flex-col h-full min-h-0 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto pb-md">
          <Stack align="center" justify="center" gap="sm" className="min-h-full">
            <HomepageIcon className="h-8" />
            <Text fw="600" size={isSmallScreen ? 'sm' : 'md'}>
              {t('What shall we write today?')}
            </Text>
            {providers.length === 0 && (
              <Button variant="light" size="xs" onClick={() => navigateToSettings('/provider')}>
                {t('Add a model to start writing')}
              </Button>
            )}
          </Stack>
        </div>

        <Stack gap="sm" className="shrink-0">
          <InputBox
            sessionType="chat"
            sessionId="new"
            model={selectedModel}
            onSelectModel={onSelectModel}
            onClickSessionSettings={onClickSessionSettings}
            onSubmit={handleSubmit}
          />
        </Stack>
      </div>
    </Page>
  )
}
