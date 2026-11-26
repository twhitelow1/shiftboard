// The model ShiftBoard's AI uses and what it costs: the one place to change either.
//
// Prices are Anthropic's list prices in USD per million tokens (Claude Haiku 5.5, as published in November 2026).
// Haiku 5.5 has two rate cards chosen by the prompt's length: up to 100K input tokens, and over it (5x). Cache
// reads are 0.1x the input rate and 5-minute cache writes 1.25x. Check https://www.anthropic.com/pricing before
// relying on the numbers for billing; the usage table keeps the tokens too, so costs can be recomputed.
export const MODEL = 'claude-haiku-5-5';

export const PRICES = {
  'claude-haiku-5-5': {
    input: 0.10, // per 1M input tokens (prompts of 100K tokens or fewer)
    output: 0.50, // per 1M output tokens
    cacheRead: 0.01, // per 1M tokens read from the prompt cache (0.1x input)
    cacheWrite: 0.125, // per 1M tokens written to the 5-minute prompt cache (1.25x input)
    longPromptAbove: 100_000, // prompts longer than this use the long rate card
    longFactor: 5, // $0.50 / $2.50 per 1M over 100K tokens
  },
};

const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

/** The usage from an API response, as ShiftBoard keeps it: plain token counts (no content). */
export function tokensOf(usage = {}) {
  return {
    inputTokens: n(usage.input_tokens),
    outputTokens: n(usage.output_tokens),
    cacheReadTokens: n(usage.cache_read_input_tokens),
    cacheWriteTokens: n(usage.cache_creation_input_tokens),
  };
}

/** Add two token counts (a tool loop's rounds). */
export const addTokens = (a, b) => ({
  inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});
export const NO_TOKENS = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/**
 * The estimated cost in USD of one API call, from its token counts (tokensOf). Rounded to a millionth of a dollar.
 * An unknown model is priced like the default one (better to over-count than to show $0).
 */
export function costUsd(tokens, model = MODEL) {
  const p = PRICES[model] || PRICES[MODEL];
  const t = { ...NO_TOKENS, ...tokens };
  const prompt = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  const f = prompt > p.longPromptAbove ? p.longFactor : 1;
  const usd = (t.inputTokens * p.input + t.outputTokens * p.output + t.cacheReadTokens * p.cacheRead + t.cacheWriteTokens * p.cacheWrite) * f / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
