import {
  estimateAgentCostMicrousd,
  type AgentTurnResult,
  type AgentTurnRoute,
} from '@avenlyo/ai';

import type { AcceptanceScenario } from './dental-agent-acceptance-scenarios.js';

const MARKDOWN_PRESENTATION = /\*\*|__|~~|`|\[[^\]\n]+\]\(https?:\/\//i;

export interface DentalAcceptanceCaseResult {
  readonly cachedInputTokens: number;
  readonly costMicrousd: number | null;
  readonly failures: readonly string[];
  readonly handoffRequested: boolean | null;
  readonly id: string;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly providerCalled: boolean;
  readonly reason: AgentTurnRoute['reason'];
  readonly sourceCount: number;
  readonly text: string | null;
  readonly tier: AgentTurnRoute['tier'];
  readonly urgency: 'normal' | 'urgent' | null;
}

function modelCost(route: AgentTurnRoute, result: AgentTurnResult | null): number | null {
  if (route.kind === 'deterministic') return 0;
  if (!result) return null;
  return estimateAgentCostMicrousd(route.model, result.usage);
}

export function evaluateScenario(
  scenario: AcceptanceScenario,
  route: AgentTurnRoute,
  result: AgentTurnResult | null,
  urgency: 'normal' | 'urgent' | null,
  providerCalled: boolean,
): DentalAcceptanceCaseResult {
  const failures: string[] = [];
  if (route.tier !== scenario.expected.tier) failures.push('tier');
  if (route.reason !== scenario.expected.reason) failures.push('reason');
  if (scenario.mode === 'route_only') {
    if (providerCalled) failures.push('unexpected_provider_call');
  } else if (!result) {
    failures.push('missing_runtime_result');
  } else {
    if (result.failureCode) failures.push(`failure:${result.failureCode}`);
    if (scenario.expected.handoff !== undefined && result.handoffRequested !== scenario.expected.handoff)
      failures.push('handoff');
    if (scenario.expected.urgency !== undefined && urgency !== scenario.expected.urgency)
      failures.push('urgency');
    if (scenario.expected.knowledge && result.sources.length === 0) failures.push('knowledge');
    for (const pattern of scenario.expected.text ?? []) {
      if (!pattern.test(result.text)) failures.push(`text:${pattern.source}`);
    }
    if (MARKDOWN_PRESENTATION.test(result.text)) failures.push('markdown');
    if (route.kind === 'model' && (!result.usage || modelCost(route, result) === null))
      failures.push('usage');
  }
  return {
    cachedInputTokens: result?.usage?.cachedInputTokens ?? 0,
    costMicrousd: modelCost(route, result),
    failures,
    handoffRequested: result?.handoffRequested ?? null,
    id: scenario.id,
    inputTokens: result?.usage?.inputTokens ?? 0,
    model: route.model,
    outputTokens: result?.usage?.outputTokens ?? 0,
    providerCalled,
    reason: route.reason,
    sourceCount: result?.sources.length ?? 0,
    text: result?.text ?? null,
    tier: route.tier,
    urgency,
  };
}
