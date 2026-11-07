import { Switch } from '@mantine/core'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import MCPStatus from '@/components/mcp/MCPStatus'
import { SettingRow, SettingsSection } from '@/components/settings/SettingsLayout'
import { useMCPServerStatus, useToggleMCPServer } from '@/hooks/mcp'
import { BUILTIN_MCP_SERVERS, type BuildinMCPServerConfig } from '@/packages/mcp/builtin'
import { useMcpSettings } from '@/stores/settingsStore'

const ServerRow: FC<{
  config: BuildinMCPServerConfig
  enabled: boolean
  onEnabledChange: (id: string, checked: boolean) => void
}> = (props) => {
  const { t } = useTranslation()
  const status = useMCPServerStatus(props.config.id)
  return (
    <SettingRow
      id={`mcp-builtin-${props.config.id}`}
      label={
        <div className="flex items-center gap-2">
          <MCPStatus status={status} />
          {props.config.name}
        </div>
      }
      description={t(props.config.description)}
      control={
        <Switch
          size="md"
          aria-label={props.config.name}
          checked={props.enabled}
          onChange={(e) => props.onEnabledChange(props.config.id, e.currentTarget.checked)}
        />
      }
    />
  )
}

export const BuiltinServersSection: FC = () => {
  const { t } = useTranslation()
  const mcp = useMcpSettings()
  const onEnabledChange = useToggleMCPServer()
  return (
    <SettingsSection title={t('Builtin MCP Servers')} description={t('Free to use, with no key needed.')}>
      {BUILTIN_MCP_SERVERS.map((config) => (
        <ServerRow
          key={config.id}
          config={config}
          enabled={mcp.enabledBuiltinServers.includes(config.id)}
          onEnabledChange={onEnabledChange}
        />
      ))}
    </SettingsSection>
  )
}
