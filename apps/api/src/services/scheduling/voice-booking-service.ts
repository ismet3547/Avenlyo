import type { Database } from '@avenlyo/database';
import type { VoiceSchedulingServices } from '@avenlyo/voice';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ApiSchedulingConnectorRegistry } from './connector-registry.js';
import { AppointmentLifecycleService } from './appointment-lifecycle-service.js';
import { SchedulingBookingService } from './scheduling-booking-service.js';

interface VoiceTurnRpc {
  rpc(
    name: 'get_voice_appointment_lifecycle_turn',
    args: { readonly target_call_id: string; readonly target_inbound_message_id: string },
  ): Promise<{
    readonly data:
      | readonly {
          readonly conversation_id: string;
          readonly inbound_message_id: string;
          readonly trusted_caller_e164: string;
        }[]
      | null;
    readonly error: { readonly message: string } | null;
  }>;
}

/** Voice adapter for the channel-neutral scheduling state machine. */
export class VoiceBookingService implements VoiceSchedulingServices {
  private readonly scheduling: SchedulingBookingService;
  private readonly lifecycle: AppointmentLifecycleService;

  public constructor(
    private readonly input: {
      readonly connectors: ApiSchedulingConnectorRegistry;
      readonly supabase: SupabaseClient<Database>;
    },
  ) {
    this.scheduling = new SchedulingBookingService({
      ...input,
      confirmationClaimMode: 'trusted_voice',
    });
    this.lifecycle = new AppointmentLifecycleService(input);
  }

  public async isEnabledForCall(context: { readonly callId: string }): Promise<boolean> {
    const turn = await this.turn(context.callId, null);
    return turn ? this.scheduling.isEnabledForConversation(turn.conversationId) : false;
  }

  public async getAvailableAppointments(
    input: {
      readonly appointmentType: string;
      readonly dates: readonly string[];
      readonly toolCallId: string;
    },
    context: { readonly callId: string },
  ) {
    const turn = await this.turn(context.callId, null);
    return turn ? this.scheduling.getAvailableAppointments(input, turn) : [];
  }

  public async prepareAppointmentBooking(
    input: {
      readonly candidateId: string;
      readonly subjectName: string | null;
      readonly toolCallId: string;
    },
    context: { readonly callId: string },
  ) {
    const turn = await this.turn(context.callId, null);
    return turn
      ? this.scheduling.prepareAppointmentBooking(input, turn)
      : { intent: null, outcome: 'not_found' as const };
  }

  public async bookAppointment(
    input: {
      readonly bookingIntentId: string;
      readonly confirmationText: string | null;
      readonly triggeringInboundMessageId: string | null;
      readonly toolCallId: string;
    },
    context: { readonly callId: string },
  ) {
    const turn = await this.turn(context.callId, input.triggeringInboundMessageId);
    if (!turn) return { outcome: 'unavailable' as const };
    return this.scheduling.bookAppointment(
      { bookingIntentId: input.bookingIntentId, toolCallId: input.toolCallId },
      turn,
    );
  }

  public async getUpcomingAppointments(
    input: { readonly triggeringInboundMessageId: string | null; readonly toolCallId: string },
    context: { readonly callId: string },
  ) {
    void input.toolCallId;
    const turn = await this.lifecycleTurn(context.callId, input.triggeringInboundMessageId);
    return turn ? this.lifecycle.getUpcomingAppointments(turn) : [];
  }

  public async getRescheduleOptions(
    input: {
      readonly appointmentReference: string;
      readonly dates: readonly string[];
      readonly triggeringInboundMessageId: string | null;
      readonly toolCallId: string;
    },
    context: { readonly callId: string },
  ) {
    void input.toolCallId;
    const turn = await this.lifecycleTurn(context.callId, input.triggeringInboundMessageId);
    return turn
      ? this.lifecycle.getRescheduleOptions(
          { appointmentReference: input.appointmentReference, dates: input.dates },
          turn,
        )
      : [];
  }

  public async prepareAppointmentReschedule(
    input: {
      readonly candidateId: string;
      readonly triggeringInboundMessageId: string | null;
      readonly toolCallId: string;
    },
    context: { readonly callId: string },
  ) {
    void input.toolCallId;
    const turn = await this.lifecycleTurn(context.callId, input.triggeringInboundMessageId);
    return turn
      ? this.lifecycle.prepareReschedule({ candidateId: input.candidateId }, turn)
      : { intent: null, outcome: 'not_found' as const };
  }

  public async prepareAppointmentCancellation(
    input: {
      readonly appointmentReference: string;
      readonly triggeringInboundMessageId: string | null;
      readonly toolCallId: string;
    },
    context: { readonly callId: string },
  ) {
    void input.toolCallId;
    const turn = await this.lifecycleTurn(context.callId, input.triggeringInboundMessageId);
    return turn
      ? this.lifecycle.prepareCancellation(
          { appointmentReference: input.appointmentReference },
          turn,
        )
      : { intent: null, outcome: 'not_found' as const };
  }

  public async executeAppointmentChange(
    input: {
      readonly changeIntentId: string;
      readonly triggeringInboundMessageId: string | null;
      readonly toolCallId: string;
    },
    context: { readonly callId: string },
  ) {
    const turn = await this.lifecycleTurn(context.callId, input.triggeringInboundMessageId);
    return turn
      ? this.lifecycle.execute(
          { changeIntentId: input.changeIntentId, toolCallId: input.toolCallId },
          turn,
        )
      : { outcome: 'confirmation_required' as const };
  }

  private async turn(callId: string, triggeringInboundMessageId: string | null) {
    const { data, error } = await this.input.supabase.rpc('get_voice_scheduling_context', {
      target_call_id: callId,
    });
    if (error) throw new Error('Could not read scheduling context.');
    const row = data[0];
    return row
      ? {
          conversationId: row.conversation_id,
          triggeringInboundMessageId,
          trustedTransportPhoneE164: row.caller_e164,
        }
      : null;
  }

  /** The transcript id is verified as an inbound message on this exact active call's conversation. */
  private async lifecycleTurn(callId: string, triggeringInboundMessageId: string | null) {
    if (!triggeringInboundMessageId) return null;
    const rpc = this.input.supabase as unknown as VoiceTurnRpc;
    const { data, error } = await rpc.rpc('get_voice_appointment_lifecycle_turn', {
      target_call_id: callId,
      target_inbound_message_id: triggeringInboundMessageId,
    });
    const row = data?.[0];
    if (error || !row) return null;
    return {
      conversationId: row.conversation_id,
      triggeringInboundMessageId: row.inbound_message_id,
      trustedCallerE164: row.trusted_caller_e164,
    };
  }
}
