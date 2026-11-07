import type { ProviderModelInfo } from '@shared/types'
import type { ChatboxAIModelList } from '@/packages/remote'

const NO_MODELS: ProviderModelInfo[] = []

/** Chatbox AI is not offered here, so nothing is fetched and nothing stored is shown. */
const useChatboxAIModels = () => ({
  allChatboxAIModels: NO_MODELS,
  chatboxAIModels: NO_MODELS,
  chatboxAIImageModels: NO_MODELS,
  chatboxAIModelList: null as ChatboxAIModelList | null,
})

export default useChatboxAIModels
