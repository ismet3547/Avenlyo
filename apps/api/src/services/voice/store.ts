import type { Database } from '@avenlyo/database';
import type { KnowledgeSource } from '@avenlyo/ai';
import {
  validateLeadCapture,
  type IndustryPack,
  type LeadCustomerGoal,
  type LeadUrgency,
} from '@avenlyo/industries';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { VoiceEndReason, VoiceCallStatus } from '@avenlyo/voice';

export interface VoiceInboundBootstrap {
  readonly accepted: boolean;
  readonly businessHours: Record<string, unknown> | null;
  readonly businessPhone: string | null;
  readonly callRecordId: string | null;
  readonly contactId: string | null;
  readonly conversationId: string | null;
  readonly isDuplicate: boolean;
  readonly locationAddress: Record<string, unknown> | null;
  readonly locationId: string | null;
  readonly locationName: string | null;
  readonly locationTimezone: string | null;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly phoneNumberId: string | null;
  readonly primaryIndustryId: string | null;
  readonly providerTransferEnabled: boolean;
  readonly transferEnabled: boolean;
  readonly transferTargetE164: string | null;
  readonly voice: string | null;
  readonly websiteUrl: string | null;
}

export interface VoiceStore {
  confirmFollowupConsent?(input: {
    readonly consentIntentId: string;
    readonly externalCallId: string;
    readonly triggeringInboundMessageId: string | null;
  }): Promise<{ readonly granted: boolean }>;
  captureLead?(input: {
    readonly customerGoal?: LeadCustomerGoal;
    readonly customerName?: string;
    readonly details: Readonly<Record<string, string>>;
    readonly externalCallId: string;
    readonly industry: IndustryPack;
    readonly serviceCategory?: string;
    readonly toolCallId: string;
    readonly triggeringInboundMessageId: string | null;
    readonly urgency: LeadUrgency;
  }): Promise<{
    readonly missingFields: readonly string[];
    readonly state: 'billing_unavailable' | 'needs_human' | 'needs_more_information' | 'needs_clarification' | 'qualified';
  }>;
  prepareFollowupConsent?(input: {
    readonly externalCallId: string;
    readonly triggeringInboundMessageId: string | null;
  }): Promise<{ readonly consentIntentId: string; readonly expiresAt: string }>;
  bootstrapIncomingCall(input: {
    readonly callerE164: string | null;
    readonly dialedE164: string | null;
    readonly eventId: string;
    readonly externalCallId: string;
    readonly sipCallId: string;
  }): Promise<VoiceInboundBootstrap | null>;
  finalizeCall(input: {
    readonly externalCallId: string;
    readonly endReason: VoiceEndReason;
    readonly status: VoiceCallStatus;
  }): Promise<void>;
  markCallActive(externalCallId: string): Promise<void>;
  recordToolExecution(input: {
    readonly externalCallId: string;
    readonly status: 'failed' | 'rejected' | 'succeeded';
    readonly toolCallId: string;
    readonly toolName: string;
  }): Promise<void>;
  recordTranscript(input: {
    readonly body: string;
    readonly direction: 'inbound' | 'outbound';
    readonly externalCallId: string;
    readonly externalItemId: string;
  }): Promise<string | null>;
  requestHandoff(input: {
    readonly externalCallId: string;
    readonly reason: string;
    readonly toolCallId: string;
    readonly urgency: 'normal' | 'urgent';
  }): Promise<boolean>;
  searchKnowledge(input: {
    readonly embedding: readonly number[];
    readonly locationId: string;
    readonly organizationId: string;
  }): Promise<readonly KnowledgeSource[]>;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

function toNullableRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Explicit mapping keeps privileged RPC arguments out of Fastify routes and model inputs. */
export class SupabaseVoiceStore implements VoiceStore {
  public constructor(private readonly client: SupabaseClient<Database>) {}

  public async captureLead(input: {
    readonly customerGoal?: LeadCustomerGoal;
    readonly customerName?: string;
    readonly details: Readonly<Record<string, string>>;
    readonly externalCallId: string;
    readonly industry: IndustryPack;
    readonly serviceCategory?: string;
    readonly toolCallId: string;
    readonly triggeringInboundMessageId: string | null;
    readonly urgency: LeadUrgency;
  }): Promise<{
    readonly missingFields: readonly string[];
    readonly state: 'billing_unavailable' | 'needs_human' | 'needs_more_information' | 'needs_clarification' | 'qualified';
  }> {
    if (!input.triggeringInboundMessageId)
      throw new Error('Lead capture requires a caller transcript.');
    const facts = validateLeadCapture(input.industry, {
      ...(input.customerGoal ? { customerGoal: input.customerGoal } : {}),
      ...(input.customerName ? { customerName: input.customerName } : {}),
      details: input.details,
      ...(input.serviceCategory ? { serviceCategory: input.serviceCategory } : {}),
      urgency: input.urgency,
    });
    const rpc = this.client as unknown as {
      rpc(
        name: 'capture_conversation_lead',
        args: Record<string, unknown>,
      ): Promise<{
        data:
          | readonly {
              readonly missing_fields: readonly string[];
              readonly state:
                'billing_unavailable' | 'needs_human' | 'needs_more_information' | 'needs_clarification' | 'qualified';
            }[]
          | null;
        error: { readonly message: string } | null;
      }>;
    };
    const { data, error } = await rpc.rpc('capture_conversation_lead', {
      target_customer_goal: facts.facts.customerGoal ?? null,
      target_customer_name: facts.facts.customerName ?? null,
      target_details: facts.facts.details,
      target_inbound_message_id: input.triggeringInboundMessageId,
      target_qualification: facts.qualification,
      target_service_category: facts.facts.serviceCategory ?? null,
      target_tool_call_id: input.toolCallId,
      target_urgency: facts.facts.urgency,
      target_voice_call_id: input.externalCallId,
    });
    if (error || !data?.[0]) throw new Error('Voice lead capture failed.');
    return { missingFields: data[0].missing_fields, state: data[0].state };
  }

  public async prepareFollowupConsent(input: {
    readonly externalCallId: string;
    readonly triggeringInboundMessageId: string | null;
  }): Promise<{ readonly consentIntentId: string; readonly expiresAt: string }> {
    if (!input.triggeringInboundMessageId)
      throw new Error('Voice consent requires a caller transcript.');
    const rpc = this.client as unknown as {
      rpc(
        name: string,
        args: Record<string, unknown>,
      ): Promise<{
        data: readonly { consent_intent_id: string; expires_at: string }[] | null;
        error: { message: string } | null;
      }>;
    };
    const { data, error } = await rpc.rpc('prepare_voice_sms_followup_consent', {
      target_call_id: input.externalCallId,
      target_prepared_message_id: input.triggeringInboundMessageId,
    });
    if (error || !data?.[0]) throw new Error('Voice follow-up consent is unavailable.');
    return { consentIntentId: data[0].consent_intent_id, expiresAt: data[0].expires_at };
  }

  public async confirmFollowupConsent(input: {
    readonly consentIntentId: string;
    readonly externalCallId: string;
    readonly triggeringInboundMessageId: string | null;
  }): Promise<{ readonly granted: boolean }> {
    if (!input.triggeringInboundMessageId)
      throw new Error('Voice consent requires a later caller transcript.');
    const rpc = this.client as unknown as {
      rpc(
        name: string,
        args: Record<string, unknown>,
      ): Promise<{
        data: readonly { granted: boolean }[] | null;
        error: { message: string } | null;
      }>;
    };
    const { data, error } = await rpc.rpc('confirm_voice_sms_followup_consent', {
      target_call_id: input.externalCallId,
      target_consent_intent_id: input.consentIntentId,
      target_confirmed_message_id: input.triggeringInboundMessageId,
    });
    if (error || !data?.[0]) throw new Error('Voice follow-up consent confirmation failed.');
    return { granted: data[0].granted };
  }

  public async bootstrapIncomingCall(input: {
    readonly callerE164: string | null;
    readonly dialedE164: string | null;
    readonly eventId: string;
    readonly externalCallId: string;
    readonly sipCallId: string;
  }): Promise<VoiceInboundBootstrap | null> {
    const { data, error } = await this.client.rpc('bootstrap_inbound_voice_call', {
      target_caller_e164: input.callerE164,
      target_dialed_e164: input.dialedE164,
      target_event_id: input.eventId,
      target_event_type: 'realtime.call.incoming',
      target_external_call_id: input.externalCallId,
      target_sip_call_id: input.sipCallId,
    });
    if (error) throw new Error('Voice call bootstrap failed.');
    const row = data[0];
    if (!row) return null;
    return {
      accepted: row.accepted,
      businessHours: toNullableRecord(row.business_hours),
      businessPhone: row.business_phone,
      callRecordId: row.call_record_id,
      contactId: row.contact_id,
      conversationId: row.conversation_id,
      isDuplicate: row.is_duplicate,
      locationAddress: toNullableRecord(row.location_address),
      locationId: row.location_id,
      locationName: row.location_name,
      locationTimezone: row.location_timezone,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      phoneNumberId: row.phone_number_id,
      primaryIndustryId: row.primary_industry_id,
      providerTransferEnabled: row.provider_transfer_enabled,
      transferEnabled: row.transfer_enabled,
      transferTargetE164: row.transfer_target_e164,
      voice: row.voice,
      websiteUrl: row.website_url,
    };
  }

  public async finalizeCall(input: {
    readonly externalCallId: string;
    readonly endReason: VoiceEndReason;
    readonly status: VoiceCallStatus;
  }): Promise<void> {
    const { error } = await this.client.rpc('finalize_inbound_voice_call', {
      target_call_id: input.externalCallId,
      target_end_reason: input.endReason,
      target_status: input.status,
    });
    if (error) throw new Error('Voice call finalization failed.');
  }

  public async markCallActive(externalCallId: string): Promise<void> {
    const { error } = await this.client.rpc('mark_inbound_voice_call_active', {
      target_call_id: externalCallId,
    });
    if (error) throw new Error('Voice call activation failed.');
  }

  public async recordToolExecution(input: {
    readonly externalCallId: string;
    readonly status: 'failed' | 'rejected' | 'succeeded';
    readonly toolCallId: string;
    readonly toolName: string;
  }): Promise<void> {
    const { error } = await this.client.rpc('record_inbound_voice_tool_execution', {
      target_call_id: input.externalCallId,
      target_status: input.status,
      target_tool_call_id: input.toolCallId,
      target_tool_name: input.toolName,
    });
    if (error) throw new Error('Voice tool audit failed.');
  }

  public async recordTranscript(input: {
    readonly body: string;
    readonly direction: 'inbound' | 'outbound';
    readonly externalCallId: string;
    readonly externalItemId: string;
  }): Promise<string | null> {
    const { data, error } = await this.client.rpc('record_inbound_voice_transcript', {
      target_body: input.body,
      target_call_id: input.externalCallId,
      target_direction: input.direction,
      target_external_item_id: input.externalItemId,
    });
    if (error) throw new Error('Voice transcript persistence failed.');
    if (!data) return null;
    const { data: messageId, error: messageError } = await this.client.rpc(
      'get_voice_transcript_message_id',
      {
        target_call_id: input.externalCallId,
        target_external_item_id: input.externalItemId,
      },
    );
    if (messageError) throw new Error('Voice transcript identifier lookup failed.');
    return messageId;
  }

  public async requestHandoff(input: {
    readonly externalCallId: string;
    readonly reason: string;
    readonly toolCallId: string;
    readonly urgency: 'normal' | 'urgent';
  }): Promise<boolean> {
    const { data, error } = await this.client.rpc('request_inbound_voice_handoff', {
      target_call_id: input.externalCallId,
      target_reason: input.reason,
      target_tool_call_id: input.toolCallId,
      target_urgency: input.urgency,
    });
    if (error) throw new Error('Voice handoff persistence failed.');
    // A replay that finds an existing handoff is still a successful, durable handoff.
    return data.length > 0;
  }

  public async searchKnowledge(input: {
    readonly embedding: readonly number[];
    readonly locationId: string;
    readonly organizationId: string;
  }): Promise<readonly KnowledgeSource[]> {
    const { data, error } = await this.client.rpc('match_inbound_voice_knowledge', {
      query_embedding_text: vectorLiteral(input.embedding),
      requested_match_count: 3,
      target_location_id: input.locationId,
      target_organization_id: input.organizationId,
    });
    if (error) throw new Error('Voice knowledge lookup failed.');
    return data.map((match) => ({
      content: match.content,
      similarity: match.similarity,
      sourceUrl: match.source_url,
      title: match.title,
    }));
  }
}
