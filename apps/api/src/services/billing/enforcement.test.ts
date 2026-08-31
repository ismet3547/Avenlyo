import type { Database } from '@avenlyo/database';
import type { BookingConnector } from '@avenlyo/integrations';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { AppointmentReminderWorker } from '../messaging/appointment-reminder-worker.js';
import { LeadFollowupWorker } from '../messaging/lead-followup-worker.js';
import { MessageProcessingWorker } from '../messaging/worker.js';
import type { ApiSchedulingConnectorRegistry } from '../scheduling/connector-registry.js';
import { SchedulingBookingService } from '../scheduling/scheduling-booking-service.js';

/**
 * Phase 17 enforcement lives in SQL, at the durable execution claim, so these tests deliberately do
 * not re-implement the entitlement decision in TypeScript. What they prove is the ordering
 * invariant the SQL depends on: for every paid operation, the application asks the
 * entitlement-aware claim FIRST, and when that claim declines, no provider or model client is
 * reached at all.
 *
 * That is the property a regression would actually break. A worker that called Twilio before its
 * claim, or that treated an empty claim as a reason to fall back to a direct provider call, would
 * make the database gate decorative no matter how correct the SQL is. Every provider client below
 * is a counter, and every assertion about it is zero.
 */

type Rpc = ReturnType<typeof vi.fn>;

function supabaseWith(handler: (name: string) => unknown): {
  rpc: Rpc;
  client: SupabaseClient<Database>;
} {
  const rpc = vi.fn((name: string) => Promise.resolve(handler(name)));
  return { client: { rpc } as unknown as SupabaseClient<Database>, rpc };
}

const declined = { data: [], error: null };

describe('message processing under billing suppression', () => {
  it('reaches no model or Twilio client when the job claim returns nothing', async () => {
    const replyTo = vi.fn();
    const send = vi.fn();
    const { client, rpc } = supabaseWith((name) =>
      name === 'claim_message_processing_jobs' ? declined : { data: null, error: null },
    );
    const worker = new MessageProcessingWorker({
      agent: { replyTo } as never,
      supabase: client,
      twilio: { send, verifySmsCapability: vi.fn() },
    });

    await (worker as unknown as { run(): Promise<void> }).run();

    expect(rpc).toHaveBeenCalledWith('claim_message_processing_jobs', {
      target_limit: 4,
      target_worker_id: expect.stringContaining('api-'),
    });
    expect(replyTo).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('posts nothing to Twilio when the submission claim declines the delivery', async () => {
    const send = vi.fn();
    const { client, rpc } = supabaseWith((name) =>
      name === 'claim_sms_delivery_submission' ? declined : { data: null, error: null },
    );
    const worker = new MessageProcessingWorker({
      supabase: client,
      twilio: { send, verifySmsCapability: vi.fn() },
    });

    await (worker as unknown as { deliverSms(id: string): Promise<void> }).deliverSms('message-1');

    expect(rpc).toHaveBeenCalledWith('claim_sms_delivery_submission', {
      target_message_id: 'message-1',
    });
    expect(send).not.toHaveBeenCalled();
    // A declined claim is a deliberate non-send, not an ambiguous one. Marking it unknown would
    // claim a Twilio request may have happened when none did.
    expect(rpc).not.toHaveBeenCalledWith('mark_sms_delivery_unknown', expect.anything());
  });

  it('asks the claim before it would ever construct a provider request', async () => {
    const order: string[] = [];
    const send = vi.fn(() => {
      order.push('twilio');
      return Promise.resolve({ messageSid: 'SM'.padEnd(34, '1'), providerStatus: 'queued' });
    });
    const rpc = vi.fn((name: string) => {
      order.push(name);
      if (name === 'claim_sms_delivery_submission') {
        return Promise.resolve({
          data: [
            {
              body: 'Hello',
              delivery_id: 'delivery-1',
              from_e164: '+14155550901',
              message_id: 'message-1',
              status: 'submitting',
              to_e164: '+14155550101',
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const worker = new MessageProcessingWorker({
      supabase: { rpc } as unknown as SupabaseClient<Database>,
      twilio: { send, verifySmsCapability: vi.fn() },
    });

    await (worker as unknown as { deliverSms(id: string): Promise<void> }).deliverSms('message-1');

    expect(order.indexOf('claim_sms_delivery_submission')).toBeLessThan(order.indexOf('twilio'));
  });
});

describe('appointment reminders under billing suppression', () => {
  it('reads no scheduling provider and sends no SMS when the due claim returns nothing', async () => {
    const forIntegration = vi.fn();
    const { client, rpc } = supabaseWith(() => declined);
    const worker = new AppointmentReminderWorker({
      connectors: { forIntegration } as unknown as ApiSchedulingConnectorRegistry,
      supabase: client,
    });

    await (worker as unknown as { run(): Promise<void> }).run();

    expect(rpc).toHaveBeenCalledWith('claim_due_appointment_reminders', {
      target_limit: 4,
      target_worker_id: expect.stringContaining('reminder-'),
    });
    expect(forIntegration).not.toHaveBeenCalled();
    // Revalidation and materialisation both sit behind the claim, so a suppressed reminder costs
    // exactly one database round trip and nothing else.
    expect(rpc).not.toHaveBeenCalledWith(
      'get_appointment_reminder_execution_context',
      expect.anything(),
    );
    expect(rpc).not.toHaveBeenCalledWith('create_appointment_reminder_message', expect.anything());
  });
});

describe('lead follow-ups under billing suppression', () => {
  it('sends nothing when the follow-up claim returns nothing', async () => {
    const send = vi.fn();
    const { client, rpc } = supabaseWith(() => declined);
    const worker = new LeadFollowupWorker({
      supabase: client,
      twilio: { send, verifySmsCapability: vi.fn() },
    });

    await (worker as unknown as { run(): Promise<void> }).run();

    expect(rpc).toHaveBeenCalledWith('claim_lead_followup_jobs', {
      target_limit: 4,
      target_worker_id: expect.stringContaining('lead-followup-'),
    });
    expect(send).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith('create_lead_followup_message', expect.anything());
  });
});

describe('scheduling under billing suppression', () => {
  const turn = {
    conversationId: 'conversation-1',
    triggeringInboundMessageId: 'message-1',
    trustedTransportPhoneE164: null,
  } as never;

  function connectorSpy() {
    const createBooking = vi.fn();
    const getAvailability = vi.fn();
    return {
      createBooking,
      getAvailability,
      connector: { createBooking, getAvailability } as unknown as BookingConnector,
    };
  }

  it('takes no slot lease and writes to no provider when the booking claim declines', async () => {
    const spy = connectorSpy();
    const { client, rpc } = supabaseWith((name) =>
      name === 'claim_presented_conversation_scheduling_booking_intent'
        ? {
            data: [
              {
                booking_intent_id: 'intent-1',
                confirmed_message_id: null,
                state: 'billing_unavailable',
              },
            ],
            error: null,
          }
        : { data: [], error: null },
    );
    const service = new SchedulingBookingService({
      connectors: { forIntegration: vi.fn().mockResolvedValue(spy.connector) } as never,
      supabase: client,
    });

    const result = await service.bookAppointment(
      { bookingIntentId: 'intent-1', toolCallId: 'call-1' },
      turn,
    );

    // Unavailable, never unknown: an unknown outcome would assert that a provider write may have
    // happened, and this one provably never started.
    expect(result).toEqual({ outcome: 'unavailable' });
    expect(spy.createBooking).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith('claim_booking_slot_lease', expect.anything());
    expect(rpc).not.toHaveBeenCalledWith(
      'get_scheduling_booking_execution_context',
      expect.anything(),
    );
  });

  it('reads no provider availability when the scheduling context is withheld', async () => {
    const spy = connectorSpy();
    const { client } = supabaseWith(() => ({ data: [], error: null }));
    const service = new SchedulingBookingService({
      connectors: { forIntegration: vi.fn().mockResolvedValue(spy.connector) } as never,
      supabase: client,
    });

    const slots = await service.getAvailableAppointments(
      { appointmentType: 'Checkup', dates: ['2026-09-01'], toolCallId: 'call-1' },
      turn,
    );

    expect(slots).toEqual([]);
    expect(spy.getAvailability).not.toHaveBeenCalled();
  });

  it('reports scheduling as disabled for a conversation whose context is withheld', async () => {
    const { client } = supabaseWith(() => ({ data: [], error: null }));
    const service = new SchedulingBookingService({
      connectors: { forIntegration: vi.fn() } as never,
      supabase: client,
    });

    await expect(service.isEnabledForConversation('conversation-1')).resolves.toBe(false);
  });
});
