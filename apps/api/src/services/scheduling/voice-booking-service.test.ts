import type { Database } from '@avenlyo/database';
import type { BookingConnector } from '@avenlyo/integrations';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { ApiSchedulingConnectorRegistry } from './connector-registry.js';
import { VoiceBookingService } from './voice-booking-service.js';

describe('VoiceBookingService booking recovery', () => {
  it('reconciles after a simulated post-success crash and never sends another provider POST', async () => {
    const createBooking = vi.fn();
    const reconcileBooking = vi.fn().mockResolvedValue({
      appointment: { appointmentKey: 'appointment_1', providerStatus: 'unconfirmed' },
      kind: 'found',
    });
    const connector = {
      createBooking,
      reconcileBooking,
    } as unknown as BookingConnector;
    const rpc = vi.fn((name: string) => {
      if (name === 'claim_voice_scheduling_booking_intent') {
        return Promise.resolve({
          data: [
            {
              booking_intent_id: 'intent_1',
              confirmed_message_id: 'message_1',
              state: 'booking_recovery',
            },
          ],
          error: null,
        });
      }
      if (name === 'get_voice_booking_execution_context') {
        return Promise.resolve({
          data: [
            {
              appointment_type_name: 'Wellness',
              appointment_type_uid: 'type_1',
              booking_intent_id: 'intent_1',
              contact_id: null,
              conversation_id: 'conversation_1',
              default_duration_minutes: 30,
              ends_at: '2026-09-01T10:30:00.000Z',
              external_contact_uid: 'contact_1',
              external_subject_uid: 'animal_1',
              intent_status: 'booking',
              integration_id: 'integration_1',
              location_id: 'location_1',
              organization_id: 'organization_1',
              provider_appointment_id: null,
              resource_name: 'Dr Ray',
              resource_uid: 'resource_1',
              starts_at: '2026-09-01T10:00:00.000Z',
              subject_name: 'Max',
              timezone: 'UTC',
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const service = new VoiceBookingService({
      connectors: {
        forIntegration: vi.fn().mockResolvedValue(connector),
      } as unknown as ApiSchedulingConnectorRegistry,
      supabase: { rpc } as unknown as SupabaseClient<Database>,
    });

    await expect(
      service.bookAppointment(
        {
          bookingIntentId: 'intent_1',
          confirmationText: 'Yes, please book it.',
          toolCallId: 'tool_1',
        },
        { callId: 'call_1' },
      ),
    ).resolves.toEqual({ outcome: 'booked' });

    expect(reconcileBooking).toHaveBeenCalledOnce();
    expect(createBooking).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('record_voice_booking_provider_success', expect.any(Object));
    expect(rpc).toHaveBeenCalledWith('complete_voice_booking_intent', expect.any(Object));
  });
});
