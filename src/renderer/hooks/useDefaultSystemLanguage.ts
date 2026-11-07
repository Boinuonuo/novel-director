import { useEffect } from 'react'
import { initSettingsStore, settingsStore } from '@/stores/settingsStore'
import platform from '../platform'

export function useSystemLanguageWhenInit() {
  useEffect(() => {
    // Waits for the stored settings, so a language chosen earlier is not overwritten.
    void initSettingsStore().then(async () => {
      const { languageInited } = settingsStore.getState()
      if (!languageInited) {
        // This client is built for Chinese fiction, so the desktop app starts in Chinese whatever the system uses.
        let locale = platform.isDesktopLike ? ('zh-Hans' as const) : await platform.getLocale()

        // 网页版暂时不自动更改简体中文，防止网址封禁
        if (platform.type === 'web') {
          if (locale === 'zh-Hans') {
            locale = 'en'
          }
        }

        settingsStore.setState({
          language: locale,
          languageInited: true,
        })
      }
      settingsStore.setState({
        languageInited: true,
      })
    })
  }, [])
}
