import type { Database } from '@avenlyo/database';
import type { VoiceSchedulingServices } from '@avenlyo/voice';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ApiSchedulingConnectorRegistry } from './connector-registry.js';
import { SchedulingBookingService } from './scheduling-booking-service.js';

/** Voice adapter for the channel-neutral scheduling state machine. */
export class VoiceBookingService implements VoiceSchedulingServices {
  private readonly scheduling: SchedulingBookingService;

  public constructor(
    private readonly input: {
      readonly connectors: ApiSchedulingConnectorRegistry;
      readonly supabase: SupabaseClient<Database>;
    },
  ) {
    this.scheduling = new SchedulingBookingService(input);
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

  private async turn(callId: string, triggeringInboundMessageId: string | null) {
    const { data, error } = await this.input.supabase.rpc('get_voice_scheduling_context', {
      target_call_id: callId,
    });
    if (error) throw new Error('Could not read scheduling context.');
    const row = data[0];
    return row ? { conversationId: row.conversation_id, triggeringInboundMessageId } : null;
  }
}
