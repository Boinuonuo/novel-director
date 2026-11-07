import deepmerge from 'deepmerge'
import {
  createDefaultSettings,
  DEFAULT_SYSTEM_PROMPT,
  getDefaultDocumentParser,
  LEGACY_DEFAULT_SYSTEM_PROMPT,
  type SettingsHostDefaults,
} from './settings-defaults'
import { type Settings, SettingsSchema } from './settings-schema'

export const SETTINGS_PERSIST_VERSION = 12

/** Compaction threshold persisted as the default by settings versions up to 7. */
const VERSION_7_DEFAULT_COMPACTION_THRESHOLD = 0.6

export interface PersistedSettingsEnvelope {
  settings: unknown
  version: number
}

export function decodePersistedSettings(value: unknown): PersistedSettingsEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { __version = 0, ...settings } = value as Record<string, unknown> & { __version?: unknown }
  return {
    settings,
    version: typeof __version === 'number' && Number.isFinite(__version) ? __version : 0,
  }
}

export function encodePersistedSettings(settings: Settings): Settings & { __version: number } {
  return {
    ...settings,
    __version: SETTINGS_PERSIST_VERSION,
  }
}

/**
 * Preserves the cumulative migration semantics previously owned by Zustand
 * persist. Every older integer version receives all later migrations.
 */
export function migrateSettings(persisted: unknown, version: number, host: SettingsHostDefaults): Settings {
  const settings = deepmerge<Record<string, unknown>>(createDefaultSettings(), persisted ?? {}, {
    arrayMerge: (_target, source) => source,
  })

  const shouldRunMigration = (migrationVersion: number) =>
    Number.isInteger(version) && version >= 0 && version <= migrationVersion

  if (version === 0) {
    const shortcuts = settings.shortcuts as Record<string, unknown>
    shortcuts.inputBoxSendMessage = shortcuts.inpubBoxSendMessage || shortcuts.inputBoxSendMessage
    shortcuts.inputBoxSendMessageWithoutResponse =
      shortcuts.inpubBoxSendMessageWithoutResponse || shortcuts.inputBoxSendMessageWithoutResponse
  }

  if (shouldRunMigration(1) && settings.licenseKey && !settings.licenseActivationMethod) {
    settings.licenseActivationMethod = 'manual'
    settings.memorizedManualLicenseKey = settings.licenseKey
  }

  if (shouldRunMigration(2)) {
    const defaults = createDefaultSettings()
    const skills = settings.skills as Record<string, unknown> | undefined
    if (!skills) {
      settings.skills = defaults.skills
    } else if (skills.translationEnabled === undefined) {
      skills.translationEnabled = true
    }
  }

  if (shouldRunMigration(4)) {
    const extension = settings.extension as { documentParser?: { type?: string } } | undefined
    if (!host.isDesktopLike && extension?.documentParser?.type === 'none') {
      extension.documentParser.type = 'chatbox-ai'
    }
  }

  if (shouldRunMigration(5)) {
    const mcp = settings.mcp as { enabledBuiltinServers?: unknown } | undefined
    if (Array.isArray(mcp?.enabledBuiltinServers)) {
      mcp.enabledBuiltinServers = mcp.enabledBuiltinServers.filter((id) => id !== 'sequentialthinking')
    }
  }

  if (shouldRunMigration(6)) {
    const mcp = settings.mcp as { enabledBuiltinServers?: unknown } | undefined
    if (Array.isArray(mcp?.enabledBuiltinServers)) {
      mcp.enabledBuiltinServers = mcp.enabledBuiltinServers.filter((id) => id !== 'edgeone-pages')
    }
  }

  // Version 8 sizes the reply reservation from the reply limit, so a stored
  // default would trigger at a different share of small windows. Only the
  // persisted default moves; a value the user chose keeps its setting.
  if (
    shouldRunMigration(7) &&
    typeof settings.compactionThreshold === 'number' &&
    Math.abs(settings.compactionThreshold - VERSION_7_DEFAULT_COMPACTION_THRESHOLD) < 1e-9
  ) {
    settings.compactionThreshold = createDefaultSettings().compactionThreshold
  }

  // Version 9: this fork has no Chatbox account, so the services behind one are replaced.
  if (shouldRunMigration(8)) {
    const extension = settings.extension as
      | { documentParser?: { type?: string }; webSearch?: { provider?: string } }
      | undefined
    settings.allowReportingAndTracking = false
    if (extension?.webSearch?.provider === 'build-in') extension.webSearch.provider = 'bing'
    if (host.isDesktopLike && extension?.documentParser?.type === 'chatbox-ai') extension.documentParser.type = 'local'
  }

  // Version 10: Fetch and arXiv were hosted by Chatbox and are gone.
  if (shouldRunMigration(9)) {
    const mcp = settings.mcp as { enabledBuiltinServers?: unknown } | undefined
    if (Array.isArray(mcp?.enabledBuiltinServers)) {
      mcp.enabledBuiltinServers = mcp.enabledBuiltinServers.filter((id) => id !== 'fetch' && id !== 'arxiv')
    }
  }

  // Version 12: the untouched stock prompt follows the new default.
  if (shouldRunMigration(11) && settings.defaultPrompt === LEGACY_DEFAULT_SYSTEM_PROMPT) {
    settings.defaultPrompt = DEFAULT_SYSTEM_PROMPT
  }

  // Version 11: forget Chatbox AI, its account and every selection that pointed at it.
  if (shouldRunMigration(10)) {
    const providers = settings.providers as Record<string, unknown> | undefined
    if (providers) delete providers['chatbox-ai']
    for (const key of [
      'licenseKey',
      'licenseDetail',
      'licenseInstances',
      'licensePlanName',
      'hasExpiredLicense',
      'licenseActivationMethod',
      'memorizedManualLicenseKey',
    ]) {
      delete settings[key]
    }
    if (Array.isArray(settings.favoritedModels)) {
      settings.favoritedModels = settings.favoritedModels.filter(
        (favorite: { provider?: string }) => favorite?.provider !== 'chatbox-ai'
      )
    }
    for (const key of Object.keys(settings)) {
      const value = settings[key] as { provider?: unknown } | null | undefined
      if (key.endsWith('Model') && value && typeof value === 'object' && value.provider === 'chatbox-ai') {
        delete settings[key]
      }
    }
    const skills = settings.skills as { enabledSkillNames?: unknown } | undefined
    if (Array.isArray(skills?.enabledSkillNames)) {
      skills.enabledSkillNames = skills.enabledSkillNames.filter(
        (name) => name !== 'chatbox-product-info' && name !== 'vibedrop'
      )
    }
  }

  const extension = settings.extension as { documentParser?: { type?: string } } | undefined
  if (!extension?.documentParser) {
    settings.extension = {
      ...extension,
      documentParser: getDefaultDocumentParser(host),
    }
  }

  return SettingsSchema.parse(settings)
}
