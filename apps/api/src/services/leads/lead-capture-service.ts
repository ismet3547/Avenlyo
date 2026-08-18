import type { Database } from '@avenlyo/database';
import {
  validateLeadCapture,
  type IndustryPack,
  type LeadCustomerGoal,
  type LeadUrgency,
} from '@avenlyo/industries';
import type { SupabaseClient } from '@supabase/supabase-js';

interface LeadCaptureRpc {
  rpc(
    name: 'capture_conversation_lead',
    args: {
      readonly target_customer_goal: LeadCustomerGoal | null;
      readonly target_customer_name: string | null;
      readonly target_details: Readonly<Record<string, string>>;
      readonly target_inbound_message_id: string;
      readonly target_qualification: 'needs_human' | 'needs_more_information' | 'qualified';
      readonly target_service_category: string | null;
      readonly target_tool_call_id: string;
      readonly target_urgency: LeadUrgency;
      readonly target_voice_call_id: string | null;
    },
  ): Promise<{
    readonly data:
      | readonly {
          readonly missing_fields: readonly string[];
          readonly state:
            'needs_human' | 'needs_more_information' | 'needs_clarification' | 'qualified';
        }[]
      | null;
    readonly error: { readonly message: string } | null;
  }>;
}

/** A server-only adapter that validates industry facts before the database verifies the exact turn. */
export class LeadCaptureService {
  public constructor(private readonly supabase: SupabaseClient<Database>) {}

  public async capture(input: {
    readonly customerGoal?: LeadCustomerGoal;
    readonly customerName?: string;
    readonly details: Readonly<Record<string, string>>;
    readonly industry: IndustryPack;
    readonly inboundMessageId: string | null;
    readonly voiceCallId?: string | null;
    readonly serviceCategory?: string;
    readonly toolCallId: string;
    readonly urgency: LeadUrgency;
  }): Promise<{
    readonly missingFields: readonly string[];
    readonly state: 'needs_human' | 'needs_more_information' | 'needs_clarification' | 'qualified';
  }> {
    if (!input.inboundMessageId)
      throw new Error('Lead capture requires an inbound customer message.');
    const validated = validateLeadCapture(input.industry, {
      ...(input.customerGoal ? { customerGoal: input.customerGoal } : {}),
      ...(input.customerName ? { customerName: input.customerName } : {}),
      details: input.details,
      ...(input.serviceCategory ? { serviceCategory: input.serviceCategory } : {}),
      urgency: input.urgency,
    });
    const rpc = this.supabase as unknown as LeadCaptureRpc;
    const { data, error } = await rpc.rpc('capture_conversation_lead', {
      target_customer_goal: validated.facts.customerGoal ?? null,
      target_customer_name: validated.facts.customerName ?? null,
      target_details: validated.facts.details,
      target_inbound_message_id: input.inboundMessageId,
      target_qualification: validated.qualification,
      target_service_category: validated.facts.serviceCategory ?? null,
      target_tool_call_id: input.toolCallId,
      target_urgency: validated.facts.urgency,
      target_voice_call_id: input.voiceCallId ?? null,
    });
    if (error || !data?.[0]) throw new Error('Lead capture could not be persisted.');
    return { missingFields: data[0].missing_fields, state: data[0].state };
  }
}
