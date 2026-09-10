import type { AgentProviderUsage } from './types';

export const agentPricingVersion = '2026-09-10';

interface ModelPricing {
  readonly cachedInputUsdPerMillion: number;
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

const pricing: Readonly<Record<'luna' | 'sol' | 'terra', ModelPricing>> = {
  luna: { cachedInputUsdPerMillion: 0.02, inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.2 },
  terra: { cachedInputUsdPerMillion: 0.2, inputUsdPerMillion: 2, outputUsdPerMillion: 12 },
  sol: { cachedInputUsdPerMillion: 0.4, inputUsdPerMillion: 4, outputUsdPerMillion: 20 },
};

function pricingForModel(model: string): ModelPricing | null {
  if (model === 'deterministic')
    return { cachedInputUsdPerMillion: 0, inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  if (model === 'gpt-5.6' || model.startsWith('gpt-5.6-sol')) return pricing.sol;
  if (model.startsWith('gpt-5.6-terra')) return pricing.terra;
  if (model.startsWith('gpt-5.6-luna')) return pricing.luna;
  return null;
}

/**
 * Estimates text-token cost in millionths of a US dollar. The pricing version is exported beside
 * this function so stored telemetry can always say which rate table produced the estimate.
 * Unknown/custom models intentionally return null instead of inventing a price.
 */
export function estimateAgentCostMicrousd(
  model: string,
  usage: AgentProviderUsage | undefined,
): number | null {
  const modelPricing = pricingForModel(model);
  if (!modelPricing) return null;
  const inputTokens = Math.max(0, usage?.inputTokens ?? 0);
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, usage?.cachedInputTokens ?? 0));
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const outputTokens = Math.max(0, usage?.outputTokens ?? 0);

  // A price of $X / 1M tokens is exactly X micro-USD per token.
  return Math.round(
    uncachedInputTokens * modelPricing.inputUsdPerMillion +
      cachedInputTokens * modelPricing.cachedInputUsdPerMillion +
      outputTokens * modelPricing.outputUsdPerMillion,
  );
}
