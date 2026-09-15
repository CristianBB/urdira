const TOKEN_COUNTERS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];

const finiteCounter = (value) => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value)
  : null;

/**
 * Normalize provider usage without turning an absent counter into zero.
 * The benchmark's comparable total remains input + output + reasoning;
 * cached input is reported separately and is required for billing.
 */
export function summarizeTokenUsage(usage, options = {}) {
  const records = Array.isArray(usage) ? usage.map((item) => item ?? {}) : [];
  const available = Object.fromEntries(TOKEN_COUNTERS.map((field) => [field, records.length > 0 && records.every((item) => finiteCounter(item[field]) !== null)]));
  const complete = TOKEN_COUNTERS.every((field) => available[field]);
  const explicitMode = options.counterMode === "cumulative" || options.counterMode === "per_turn" ? options.counterMode : null;
  const cumulative = explicitMode === "cumulative";
  const perTurn = explicitMode === "per_turn";
  const proven = explicitMode !== null;
  const evidenceRequired = options.requireCounterEvidence === true;
  const semantics = records.length === 0 || !proven ? "unknown" : cumulative ? "cumulative_thread" : perTurn ? "per_turn" : "unknown";
  const total = (field) => {
    if (!available[field] || !proven && (records.length > 1 || evidenceRequired)) return null;
    return cumulative ? finiteCounter(records.at(-1)?.[field]) : records.reduce((sum, item) => sum + finiteCounter(item[field]), 0);
  };
  const input = total("input_tokens");
  const cachedInput = total("cached_input_tokens");
  const output = total("output_tokens");
  const reasoning = total("reasoning_output_tokens");
  const uncachedInput = input === null || cachedInput === null ? null : Math.max(0, input - cachedInput);
  const totalTokens = input === null || output === null || reasoning === null ? null : input + output + reasoning;
  return {
    input_tokens: input,
    cached_input_tokens: cachedInput,
    uncached_input_tokens: uncachedInput,
    output_tokens: output,
    reasoning_tokens: reasoning,
    total_tokens: totalTokens,
    token_usage_semantics: semantics,
    complete,
    counter_mode: explicitMode,
  };
}

export function withTokenCost(metrics, rates) {
  const inputRate = Number(rates.input);
  const cachedInputRate = Number(rates.cached_input);
  const outputRate = Number(rates.output);
  const reasoningRate = Number(rates.reasoning);
  const ratesValid = [inputRate, cachedInputRate, outputRate, reasoningRate].every(Number.isFinite);
  const costable = ratesValid
    && metrics.input_tokens !== null
    && metrics.cached_input_tokens !== null
    && metrics.output_tokens !== null
    && metrics.reasoning_tokens !== null;
  return {
    ...metrics,
    estimated_cost_usd: costable
      ? (metrics.uncached_input_tokens * inputRate
        + metrics.cached_input_tokens * cachedInputRate
        + metrics.output_tokens * outputRate
        + metrics.reasoning_tokens * reasoningRate) / 1_000_000
      : null,
    estimated_cost_rates_usd_per_million: {
      input: inputRate,
      cached_input: cachedInputRate,
      output: outputRate,
      reasoning: reasoningRate,
    },
  };
}

export { TOKEN_COUNTERS };
