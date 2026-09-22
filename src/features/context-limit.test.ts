import { describe, it, expect } from 'vitest'
import { contextLimitForModel, contextSizeOf, exceedsContextPct } from './context-limit.js'

describe('contextLimitForModel', () => {
  it('gives 1M to opus, fable and sonnet 5+', () => {
    expect(contextLimitForModel('claude-opus-5')).toBe(1_000_000)
    expect(contextLimitForModel('claude-fable-5-1')).toBe(1_000_000)
    expect(contextLimitForModel('claude-sonnet-5')).toBe(1_000_000)
  })
  it('gives 200k to haiku, older sonnet and unknown', () => {
    expect(contextLimitForModel('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(contextLimitForModel('claude-sonnet-4-5')).toBe(200_000)
    expect(contextLimitForModel(null)).toBe(200_000)
  })
})

describe('exceedsContextPct', () => {
  it('trips at the configured percentage of the model window', () => {
    expect(exceedsContextPct(300_000, 'claude-fable-5-1', 30).exceeded).toBe(true)
    expect(exceedsContextPct(290_000, 'claude-opus-5', 30).exceeded).toBe(false)
    expect(exceedsContextPct(60_000, 'claude-haiku-4-5', 30).exceeded).toBe(true)
  })
  it('is disabled at 0', () => {
    expect(exceedsContextPct(900_000, 'claude-opus-5', 0).exceeded).toBe(false)
  })
  it('sums input + cache tokens but not output', () => {
    expect(contextSizeOf({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 })).toBe(6)
  })
})
