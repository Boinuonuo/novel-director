import type { MCPServerConfig } from './types'

export interface BuildinMCPServerConfig {
  id: string
  name: string
  description: string
  url: string
}

export const BUILTIN_MCP_SERVERS: BuildinMCPServerConfig[] = [
  {
    id: 'context7',
    name: 'Context7',
    description: 'Retrieves up-to-date documentation and code examples for any library.',
    // Upstash's public endpoint: free within its rate limits, and needs no key.
    url: 'https://mcp.context7.com/mcp',
  },
]

export function getBuiltinServerConfig(id: string): MCPServerConfig | null {
  const config = BUILTIN_MCP_SERVERS.find((s) => s.id === id)
  if (!config) {
    return null
  }
  return {
    id,
    name: config.name,
    enabled: true,
    protocolMode: 'auto',
    transport: {
      type: 'http',
      url: config.url,
    },
  }
}
