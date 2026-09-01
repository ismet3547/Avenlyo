import { veterinaryPack } from '@avenlyo/industries';
import { activeVoiceTools, type VoiceToolExecution } from '@avenlyo/voice';
import { describe, expect, it } from 'vitest';

import { customerVisibleVoiceTools, VoiceToolAuthorityState } from './tool-authority.js';

function execution(modelOutput: Readonly<Record<string, unknown>>): VoiceToolExecution {
  return {
    handoffRequested: false,
    modelOutput: JSON.stringify(modelOutput),
    status: 'succeeded',
    summary: 'ok',
    transferred: false,
  };
}

const transcriptId = '00000000-0000-4000-8000-000000000014';

function call(name: string, argumentsValue = '{}') {
  return {
    arguments: argumentsValue,
    callId: `call-${name}`,
    confirmationText: 'yes',
    name,
    triggeringInboundMessageId: transcriptId,
  } as const;
}

describe('voice trusted tool authority', () => {
  it('removes durable authority parameters from provider-visible tool contracts', () => {
    const tools = customerVisibleVoiceTools(
      activeVoiceTools({
        industry: veterinaryPack,
        schedulingEnabled: true,
        transferEnabled: false,
      }),
    );

    for (const name of [
      'book_appointment',
      'reschedule_appointment',
      'cancel_appointment',
      'confirm_sms_followup_consent',
    ]) {
      expect(tools.find((tool) => tool.name === name)?.parameters).toEqual({
        additionalProperties: false,
        properties: {},
        required: [],
        type: 'object',
      });
    }
    expect(
      tools.find((tool) => tool.name === 'get_available_appointments')?.parameters,
    ).not.toEqual({ additionalProperties: false, properties: {}, required: [], type: 'object' });
  });

  it('redacts a booking intent id and ignores a model-supplied replacement id', () => {
    const authority = new VoiceToolAuthorityState();
    const trustedId = '11111111-1111-4111-8111-111111111111';
    const prepared = authority.observe(
      call('prepare_appointment_booking'),
      execution({
        intent: {
          bookingIntentId: trustedId,
          startsAt: '2026-09-01T10:00:00.000Z',
          timezone: 'UTC',
          typeName: 'Wellness',
        },
        outcome: 'ready',
      }),
    );

    expect(prepared.modelOutput).not.toContain(trustedId);
    expect(authority.bind(call('book_appointment', '{"booking_intent_id":"attacker"}')).arguments).toBe(
      JSON.stringify({ booking_intent_id: trustedId }),
    );
  });

  it('binds appointment-change execution only to the matching prepared operation', () => {
    const authority = new VoiceToolAuthorityState();
    const trustedId = '22222222-2222-4222-8222-222222222222';
    const prepared = authority.observe(
      call('prepare_appointment_cancellation'),
      execution({
        intent: {
          changeIntentId: trustedId,
          operation: 'cancel',
          startsAt: '2026-09-01T10:00:00.000Z',
          timezone: 'UTC',
        },
        outcome: 'ready',
      }),
    );

    expect(prepared.modelOutput).not.toContain(trustedId);
    expect(authority.bind(call('cancel_appointment', '{"change_intent_id":"attacker"}')).arguments).toBe(
      JSON.stringify({ change_intent_id: trustedId }),
    );
    expect(authority.bind(call('reschedule_appointment', '{"change_intent_id":"attacker"}')).arguments).toBe('{}');
  });

  it('keeps confirmation-required authority but consumes it after a terminal attempt', () => {
    const authority = new VoiceToolAuthorityState();
    const trustedId = '33333333-3333-4333-8333-333333333333';
    authority.observe(
      call('prepare_appointment_booking'),
      execution({ intent: { bookingIntentId: trustedId }, outcome: 'ready' }),
    );
    const bound = authority.bind(call('book_appointment'));

    authority.observe(bound, execution({ outcome: 'confirmation_required' }));
    expect(authority.bind(call('book_appointment')).arguments).toBe(
      JSON.stringify({ booking_intent_id: trustedId }),
    );

    authority.observe(bound, execution({ outcome: 'booked' }));
    expect(authority.bind(call('book_appointment')).arguments).toBe('{}');
  });

  it('binds and redacts follow-up consent authority as single-use state', () => {
    const authority = new VoiceToolAuthorityState();
    const trustedId = '44444444-4444-4444-8444-444444444444';
    const prepared = authority.observe(
      call('prepare_sms_followup_consent'),
      execution({ consent_intent_id: trustedId, expires_at: '2026-09-01T10:10:00.000Z' }),
    );

    expect(prepared.modelOutput).not.toContain(trustedId);
    const bound = authority.bind(
      call('confirm_sms_followup_consent', '{"consent_intent_id":"attacker"}'),
    );
    expect(bound.arguments).toBe(JSON.stringify({ consent_intent_id: trustedId }));

    authority.observe(bound, execution({ granted: true }));
    expect(authority.bind(call('confirm_sms_followup_consent')).arguments).toBe('{}');
  });

  it('drops pending scheduling authority after deterministic safety escalation', () => {
    const authority = new VoiceToolAuthorityState();
    authority.observe(
      call('prepare_appointment_reschedule'),
      execution({
        intent: { changeIntentId: '55555555-5555-4555-8555-555555555555' },
        outcome: 'ready',
      }),
    );

    authority.clearSchedulingAuthority();

    expect(authority.bind(call('reschedule_appointment')).arguments).toBe('{}');
  });
});
