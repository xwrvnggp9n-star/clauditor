/**
 * Context window size by model.
 *
 * Transcripts record the bare model id (e.g. "claude-opus-5", "claude-fable-5-1")
 * without the "[1m]" suffix, so the window has to be inferred from the family.
 * Opus, Fable and Sonnet 5+ run with a 1M window in Claude Code; everything
 * else (Haiku, older Sonnet) is treated as 200k.
 */
export function contextLimitForModel(model: string | null | undefined): number {
  if (!model) return 200_000
  if (/opus|fable|sonnet-[5-9]/.test(model)) return 1_000_000
  return 200_000
}

/** Tokens in the context window for a turn (everything sent as input). */
export function contextSizeOf(usage: {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}): number {
  return (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)
}

/**
 * Should the session be rotated because context passed the configured
 * percentage of the window? `blockPct` of 0 (or less) disables the check.
 */
export function exceedsContextPct(
  contextSize: number,
  model: string | null | undefined,
  blockPct: number,
): { exceeded: boolean; pct: number; limit: number } {
  const limit = contextLimitForModel(model)
  const pct = Math.round((contextSize / limit) * 100)
  return { exceeded: blockPct > 0 && pct >= blockPct, pct, limit }
}
