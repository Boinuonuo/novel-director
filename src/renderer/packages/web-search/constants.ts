export const WEB_SEARCH_PROVIDERS = [
  { value: 'bing', label: 'Bing Search' },
  { value: 'tavily', label: 'Tavily' },
  { value: 'bocha', label: 'BoCha' },
  { value: 'querit', label: 'Querit' },
  { value: 'searxng', label: 'SearXNG' },
] as const

/** `build-in` was Chatbox's own search. It is no longer offered, and settings move off it. */
export type WebSearchProviderValue = (typeof WEB_SEARCH_PROVIDERS)[number]['value'] | 'build-in'
