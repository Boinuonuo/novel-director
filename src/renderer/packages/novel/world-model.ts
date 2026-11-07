import { getReasoningProviderOptions } from '@shared/utils/reasoning-control'
import type { ModelProvider, ProviderOptions, Settings } from '@shared/types'

type ModelSelection = NonNullable<Settings['novelArchivistModel']>

/** The world pass may use its own model; without one, the background model does the thinking too. */
export function selectBackgroundModel(
  settings: Pick<Settings, 'novelArchivistModel' | 'novelWorldModel'>,
  role?: 'world'
): ModelSelection | undefined {
  return role === 'world' ? (settings.novelWorldModel ?? settings.novelArchivistModel) : settings.novelArchivistModel
}

/** Thinking stays moderate: the pass reasons about a ledger, not a proof. Models without a control send nothing. */
export function worldThinkingOptions(selection: ModelSelection): ProviderOptions | undefined {
  return getReasoningProviderOptions(selection.provider as ModelProvider, { modelId: selection.model }, 'medium')
}
