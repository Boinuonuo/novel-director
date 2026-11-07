import { getDefaultInterfaceColors } from '../../theme-colors'
import { DEFAULT_ENABLED_BUILTIN_SKILL_NAMES } from '../../types/skills'
import { type DocumentParserConfig, type Settings, Theme } from './settings-schema'

/** For a plain chat. A new novel starts from the novel prompt instead. */
export const DEFAULT_SYSTEM_PROMPT =
  '你是一位知识广博、表达清楚的助手，也是作者构思故事时的讨论伙伴。用对方使用的语言回答，先说结论再展开，不确定的地方如实说明。'

/** The stock prompt of earlier versions. A setting still holding it moves to the new default. */
export const LEGACY_DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.'

export interface SettingsHostDefaults {
  isDesktopLike: boolean
}

export function getDefaultDocumentParser(host: SettingsHostDefaults): DocumentParserConfig {
  return host.isDesktopLike ? { type: 'local' } : { type: 'chatbox-ai' }
}

/**
 * Returns the exact historical initial snapshot without importing the broader
 * defaults module (which also initializes UUID/provider dependencies).
 */
export function createDefaultSettings(): Settings {
  return {
    showWordCount: false,
    showTokenCount: false,
    showTokenUsed: true,
    showModelName: true,
    showMessageTimestamp: false,
    showFirstTokenLatency: false,
    showAvatar: true,
    hideSystemPromptMessage: false,
    messageLayout: 'bubble',
    autoScrollNewMessagesToTop: false,
    userAvatarKey: '',
    defaultAssistantAvatarKey: '',
    backgroundImageKey: '',
    backgroundImageOpacity: 0.16,
    theme: Theme.System,
    interfaceColors: getDefaultInterfaceColors(),
    interfaceColorPresets: [],
    language: 'en',
    fontSize: 14,
    spellCheck: true,
    defaultPrompt: DEFAULT_SYSTEM_PROMPT,
    // Reports and analytics go to Chatbox's servers, so this fork never sends them.
    allowReportingAndTracking: false,
    hasExpiredLicense: false,
    chatboxAIDesktopPromptDismissed: false,
    enableMarkdownRendering: true,
    enableLaTeXRendering: true,
    enableMermaidRendering: true,
    injectDefaultMetadata: true,
    autoPreviewArtifacts: false,
    autoCollapseCodeBlock: true,
    pasteLongTextAsAFile: true,
    autoGenerateTitle: true,
    autoCompaction: true,
    compactionThreshold: 0.75,
    pauseOnToolCallLimit: true,
    autoLaunch: false,
    autoUpdate: true,
    betaUpdate: false,
    defaultEmbeddingModel: undefined,
    defaultRerankModel: undefined,
    shortcuts: {
      quickToggle: 'Alt+`',
      inputBoxFocus: 'mod+i',
      inputBoxWebBrowsingMode: 'mod+e',
      newChat: 'mod+n',
      newPictureChat: '',
      sessionListNavNext: 'mod+tab',
      sessionListNavPrev: 'mod+shift+tab',
      sessionListNavTargetIndex: 'mod',
      messageListRefreshContext: 'mod+shift+n',
      dialogOpenSearch: 'mod+k',
      inputBoxSendMessage: 'Enter',
      inputBoxSendMessageWithoutResponse: 'Ctrl+Enter',
      optionNavUp: 'up',
      optionNavDown: 'down',
      optionSelect: 'enter',
    },
    extension: {
      webSearch: {
        provider: 'bing',
        tavilyApiKey: '',
        bochaApiKey: '',
        queritApiKey: '',
        queritMaxResults: 5,
        queritTimeRange: 'none',
        searxngBaseUrl: '',
      },
      knowledgeBase: {
        models: {
          embedding: undefined,
          rerank: undefined,
        },
      },
      // Kept unset until an older persisted snapshot is migrated.
      documentParser: undefined,
    },
    mcp: {
      servers: [],
      enabledBuiltinServers: [],
    },
    skills: {
      enabledSkillNames: [...DEFAULT_ENABLED_BUILTIN_SKILL_NAMES],
      translationEnabled: true,
      builtinDefaultsInitialized: true,
      appliedDefaultBuiltinSkillNames: [...DEFAULT_ENABLED_BUILTIN_SKILL_NAMES],
    },
  }
}
