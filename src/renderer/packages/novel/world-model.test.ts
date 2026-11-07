import { describe, expect, it } from 'vitest'
import { selectBackgroundModel, worldThinkingOptions } from './world-model'

const archivist = { provider: 'deepseek', model: 'deepseek-flash' }
const world = { provider: 'claude', model: 'claude-sonnet-4-6' }

describe('selectBackgroundModel', () => {
  it('uses the world model for the world pass only', () => {
    const settings = { novelArchivistModel: archivist, novelWorldModel: world }
    expect(selectBackgroundModel(settings, 'world')).toBe(world)
    expect(selectBackgroundModel(settings)).toBe(archivist)
  })

  it('falls back to the background model', () => {
    expect(selectBackgroundModel({ novelArchivistModel: archivist }, 'world')).toBe(archivist)
  })
})

describe('worldThinkingOptions', () => {
  it('asks a model with a thinking control to use it', () => {
    expect(worldThinkingOptions(world)).toBeTruthy()
  })

  it('sends nothing to a model without one', () => {
    expect(worldThinkingOptions({ provider: 'fake', model: 'fake-writer' })).toBeUndefined()
  })
})
