import { describe, expect, it } from 'vitest';

import { agentPricingVersion, estimateAgentCostMicrousd } from './cost';

describe('agent text-token cost estimates', () => {
  it('prices Luna cached and uncached input separately', () => {
    expect(
      estimateAgentCostMicrousd('gpt-5.6-luna', {
        cachedInputTokens: 200,
        inputTokens: 1_000,
        outputTokens: 100,
      }),
    ).toBe(284);
  });

  it('recognizes the gpt-5.6 alias as Sol pricing', () => {
    expect(
      estimateAgentCostMicrousd('gpt-5.6', {
        cachedInputTokens: 0,
        inputTokens: 1_000,
        outputTokens: 100,
      }),
    ).toBe(6_000);
  });

  it('records deterministic turns as zero cost and refuses to invent prices for custom models', () => {
    expect(estimateAgentCostMicrousd('deterministic', undefined)).toBe(0);
    expect(estimateAgentCostMicrousd('custom-model', { inputTokens: 10 })).toBeNull();
  });

  it('pins the rate-table version used by telemetry', () => {
    expect(agentPricingVersion).toBe('2026-09-10');
  });
});
