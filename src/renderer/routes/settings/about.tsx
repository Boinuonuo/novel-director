import { Flex, Image } from '@mantine/core'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { SettingRow, SettingSwitchRow, SettingsPage, SettingsSection } from '@/components/settings/SettingsLayout'
import useVersion from '@/hooks/useVersion'
import { AboutDetails } from '@/routes/about'
import platform from '@/platform'
import iconPNG from '@/static/icon.png'
import { useSettingsStore } from '@/stores/settingsStore'

export const Route = createFileRoute('/settings/about')({
  component: RouteComponent,
})

export function RouteComponent() {
  const { t } = useTranslation()
  const version = useVersion()
  const autoLaunch = useSettingsStore((s) => s.autoLaunch)
  const setSettings = useSettingsStore((s) => s.setSettings)
  const hasVersion = /\d/.test(version.version)

  return (
    <SettingsPage title={t('About')}>
      <SettingsSection>
        <SettingRow
          id="version"
          label={
            <Flex align="center" gap="sm">
              <Image src={iconPNG} w={32} h={32} radius="md" />
              <span>Novel Director{hasVersion ? ` ${version.version}` : ''}</span>
            </Flex>
          }
          description={<AboutDetails />}
        />
      </SettingsSection>
      {platform.type === 'desktop' && (
        <SettingsSection title={t('Startup')}>
          <SettingSwitchRow
            id="auto-launch"
            label={t('Launch at system startup')}
            checked={autoLaunch}
            onChange={(checked) => setSettings({ autoLaunch: checked })}
          />
        </SettingsSection>
      )}
    </SettingsPage>
  )
}
