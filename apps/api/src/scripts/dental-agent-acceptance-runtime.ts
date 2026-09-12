import {
  AgentRuntime,
  ControlledToolExecutor,
  OpenAIResponsesProvider,
  routeAgentTurn,
  type KnowledgeSource,
} from '@avenlyo/ai';
import { dentalPack } from '@avenlyo/industries';
import { OpenAIEmbeddingProvider } from '@avenlyo/knowledge';

import { env } from '../env.js';
import { createServiceSupabaseClient } from '../lib/supabase.js';
import { type BusinessSnapshot } from './dental-agent-acceptance-business.js';
import type { AcceptanceScenario } from './dental-agent-acceptance-scenarios.js';
import { evaluateScenario, type DentalAcceptanceCaseResult } from './dental-agent-acceptance-evaluate.js';
export type { DentalAcceptanceCaseResult } from './dental-agent-acceptance-evaluate.js';

export async function runScenario(
  scenario: AcceptanceScenario,
  snapshot: BusinessSnapshot,
  apiKey: string,
): Promise<DentalAcceptanceCaseResult> {
  const history = scenario.history ?? [];
  const workState = { control: 'ai_active' as const, pendingMutation: null };
  const route = routeAgentTurn({
    business: snapshot.business,
    history,
    industry: dentalPack,
    models: { sol: env.OPENAI_AGENT_MODEL },
    userMessage: scenario.message,
    workState,
  });
  if (scenario.mode === 'route_only') return evaluateScenario(scenario, route, null, null, false);

  let urgency: 'normal' | 'urgent' | null = null;
  const supabase = createServiceSupabaseClient();
  if (!supabase) throw new Error('backend_not_configured');
  const embeddings = new OpenAIEmbeddingProvider({ apiKey });
  const executor = new ControlledToolExecutor(dentalPack, {
    requestHumanHelp: (tool) => {
      urgency = tool.urgency;
      return Promise.resolve({ created: true });
    },
    searchBusinessKnowledge: async (tool): Promise<readonly KnowledgeSource[]> => {
      const [embedding] = await embeddings.embed([tool.query]);
      if (!embedding) return [];
      const { data, error } = await supabase.rpc('match_inbound_voice_knowledge', {
        query_embedding_text: `[${embedding.join(',')}]`,
        requested_match_count: 3,
        target_location_id: snapshot.locationId,
        target_organization_id: snapshot.organizationId,
      });
      if (error) throw new Error('knowledge_search_failed');
      return data.map((match) => ({
        content: match.content,
        similarity: match.similarity,
        sourceUrl: match.source_url,
        title: match.title,
      }));
    },
  });
  const provider =
    route.kind === 'model' ? new OpenAIResponsesProvider({ apiKey, model: route.model }) : null;
  const result = await new AgentRuntime(provider, executor, env.OPENAI_AGENT_MODEL).runTurn({
    business: snapshot.business,
    context: {
      channel: 'web',
      conversationId: `operator-acceptance-${scenario.id}`,
      industryId: 'dental',
      locationId: snapshot.locationId,
      mode: 'test',
      organizationId: snapshot.organizationId,
    },
    history,
    industry: dentalPack,
    route,
    userMessage: scenario.message,
    workState,
  });
  return evaluateScenario(scenario, route, result, urgency, route.kind === 'model');
}
