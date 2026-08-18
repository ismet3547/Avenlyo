import {
  AgentRuntime,
  ControlledToolExecutor,
  OpenAIResponsesProvider,
  type AgentConversationMessage,
  type KnowledgeSource,
} from '@avenlyo/ai';
import type { Database, Json } from '@avenlyo/database';
import { resolveIndustryPack } from '@avenlyo/industries';
import { OpenAIEmbeddingProvider } from '@avenlyo/knowledge';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { SchedulingBookingService } from '../scheduling/scheduling-booking-service.js';
import type { AppointmentLifecycleService } from '../scheduling/appointment-lifecycle-service.js';

interface HistoryValue {
  readonly author_type?: unknown;
  readonly body?: unknown;
}

function toRecord(value: Json): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function historyFromJson(value: Json): readonly AgentConversationMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const candidate: HistoryValue = item;
    if (typeof candidate.body !== 'string' || !candidate.body.trim()) return [];
    return [
      {
        content: candidate.body,
        role: candidate.author_type === 'customer' ? 'customer' : 'assistant',
      },
    ];
  });
}

/** Reuses the Phase 3 agent core for text conversations; transport concerns stay outside it. */
export class ConversationAgentService {
  private readonly embeddings: OpenAIEmbeddingProvider;
  private readonly provider: OpenAIResponsesProvider;

  public constructor(
    private readonly input: {
      readonly apiKey: string;
      readonly model: string;
      readonly appointmentLifecycle?: AppointmentLifecycleService;
      readonly scheduling?: SchedulingBookingService;
      readonly supabase: SupabaseClient<Database>;
    },
  ) {
    this.embeddings = new OpenAIEmbeddingProvider({ apiKey: input.apiKey });
    this.provider = new OpenAIResponsesProvider({ apiKey: input.apiKey, model: input.model });
  }

  public async replyTo(
    inboundMessageId: string,
  ): Promise<{ readonly handoffRequested: boolean; readonly text: string }> {
    const { data, error } = await this.input.supabase.rpc('get_message_agent_context', {
      target_message_id: inboundMessageId,
    });
    const context = data?.[0];
    if (error || !context) throw new Error('Message agent context is unavailable.');
    const industry = resolveIndustryPack(context.industry_id);
    if (!industry) throw new Error('Message agent industry is unavailable.');
    const history = historyFromJson(context.history);
    const userMessage = history.at(-1)?.content;
    if (!userMessage) throw new Error('Inbound message body is unavailable.');
    const executor = new ControlledToolExecutor(industry, {
      requestHumanHelp: async (tool, executionContext) => {
        const { data: handoff, error: handoffError } = await this.input.supabase.rpc(
          'request_message_handoff',
          {
            target_inbound_message_id: inboundMessageId,
            target_reason: tool.reason,
            target_tool_call_id: tool.toolCallId,
            target_urgency: tool.urgency,
          },
        );
        if (handoffError) throw new Error('Message handoff could not be persisted.');
        const created = handoff[0]?.created ?? false;
        void executionContext;
        return { created };
      },
      searchBusinessKnowledge: async (tool, executionContext) => {
        if (!executionContext.locationId) return [];
        const [embedding] = await this.embeddings.embed([tool.query]);
        if (!embedding) return [];
        const { data: matches, error: matchesError } = await this.input.supabase.rpc(
          'match_inbound_voice_knowledge',
          {
            query_embedding_text: `[${embedding.join(',')}]`,
            requested_match_count: 3,
            target_location_id: executionContext.locationId,
            target_organization_id: executionContext.organizationId,
          },
        );
        if (matchesError) throw new Error('Message knowledge search failed.');
        return matches.map((match): KnowledgeSource => ({
          content: match.content,
          similarity: match.similarity,
          sourceUrl: match.source_url,
          title: match.title,
        }));
      },
      ...(this.input.scheduling
        ? {
            scheduling: {
              getAvailableAppointments: (tool, executionContext) =>
                executionContext.locationId
                  ? this.input.scheduling!.getAvailableAppointments(tool, {
                      conversationId: executionContext.conversationId,
                      triggeringInboundMessageId:
                        executionContext.triggeringInboundMessageId ?? null,
                    })
                  : Promise.resolve([]),
              prepareAppointmentBooking: (tool, executionContext) =>
                executionContext.locationId
                  ? this.input.scheduling!.prepareAppointmentBooking(tool, {
                      conversationId: executionContext.conversationId,
                      triggeringInboundMessageId:
                        executionContext.triggeringInboundMessageId ?? null,
                    })
                  : Promise.resolve({ intent: null, outcome: 'not_found' as const }),
              bookAppointment: (tool, executionContext) =>
                executionContext.locationId
                  ? this.input.scheduling!.bookAppointment(tool, {
                      conversationId: executionContext.conversationId,
                      triggeringInboundMessageId:
                        executionContext.triggeringInboundMessageId ?? null,
                    })
                  : Promise.resolve({ outcome: 'unavailable' as const }),
            },
          }
        : {}),
      ...(this.input.appointmentLifecycle
        ? { appointmentLifecycle: {
            getUpcomingAppointments: (_tool, executionContext) => this.input.appointmentLifecycle!.getUpcomingAppointments({ conversationId: executionContext.conversationId, triggeringInboundMessageId: executionContext.triggeringInboundMessageId ?? null }),
            getRescheduleOptions: (tool, executionContext) => this.input.appointmentLifecycle!.getRescheduleOptions({ appointmentReference: tool.appointmentReference, dates: tool.dates }, { conversationId: executionContext.conversationId, triggeringInboundMessageId: executionContext.triggeringInboundMessageId ?? null }),
            prepareReschedule: (tool, executionContext) => this.input.appointmentLifecycle!.prepareReschedule({ candidateId: tool.candidateId }, { conversationId: executionContext.conversationId, triggeringInboundMessageId: executionContext.triggeringInboundMessageId ?? null }),
            prepareCancellation: (tool, executionContext) => this.input.appointmentLifecycle!.prepareCancellation({ appointmentReference: tool.appointmentReference }, { conversationId: executionContext.conversationId, triggeringInboundMessageId: executionContext.triggeringInboundMessageId ?? null }),
            execute: (tool, executionContext) => this.input.appointmentLifecycle!.execute(tool, { conversationId: executionContext.conversationId, triggeringInboundMessageId: executionContext.triggeringInboundMessageId ?? null }),
          } }
        : {}),
    });
    const runtime = new AgentRuntime(this.provider, executor, this.input.model);
    const locationAddress = toRecord(context.location_address);
    const result = await runtime.runTurn({
      business: {
        address: locationAddress ? JSON.stringify(locationAddress) : null,
        businessHours: context.business_hours ? JSON.stringify(context.business_hours) : null,
        locationName: context.location_name,
        name: context.organization_name,
        phone: context.business_phone,
        timezone: context.location_timezone,
        website: context.website_url,
      },
      context: {
        conversationId: context.conversation_id,
        channel: context.channel_type === 'sms' ? 'sms' : 'web',
        industryId: industry.id,
        locationId: context.location_id,
        mode: 'customer',
        organizationId: context.organization_id,
        triggeringInboundMessageId: inboundMessageId,
      },
      history: history.slice(0, -1),
      industry,
      userMessage,
    });
    if (context.channel_type === 'sms' && result.text.length > 800 && !result.handoffRequested) {
      await this.input.supabase.rpc('request_message_handoff', {
        target_inbound_message_id: inboundMessageId,
        target_reason: 'The requested SMS response exceeded the safe single-message limit.',
        target_tool_call_id: `sms-length-${inboundMessageId}`,
        target_urgency: 'normal',
      });
      return {
        handoffRequested: true,
        text: 'Thanks for your message. Iâ€™m asking the team to follow up with the details.',
      };
    }
    return { handoffRequested: result.handoffRequested, text: result.text };
  }
}
