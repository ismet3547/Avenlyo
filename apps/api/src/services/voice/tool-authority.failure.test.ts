import { describe, expect, it } from 'vitest';

import type { VoiceToolExecution } from '@avenlyo/voice';

import { VoiceToolAuthorityState } from './tool-authority.js';

const trustedId = '11111111-1111-4111-8111-111111111111';

function call(name: string, argumentsValue = '{}') {
  return {
    arguments: argumentsValue,
    callId: `call-${name}`,
    confirmationText: 'yes',
    name,
    triggeringInboundMessageId: '00000000-0000-4000-8000-000000000014',
  } as const;
}

function execution(input: {
  readonly handoffRequested?: boolean;
  readonly modelOutput: string;
  readonly status: VoiceToolExecution['status'];
}): VoiceToolExecution {
  return {
    handoffRequested: input.handoffRequested ?? false,
    modelOutput: input.modelOutput,
    status: input.status,
    summary: 'result',
    transferred: false,
  };
}

function preparedAuthority(): VoiceToolAuthorityState {
  const authority = new VoiceToolAuthorityState();
  authority.observe(
    call('prepare_appointment_booking'),
    execution({
      modelOutput: JSON.stringify({
        intent: { bookingIntentId: trustedId },
        outcome: 'ready',
      }),
      status: 'succeeded',
    }),
  );
  return authority;
}

describe('VoiceToolAuthorityState mutation failure classification', () => {
  it('forces human review for an unclassified failed consequential execution', () => {
    const authority = preparedAuthority();
    const bound = authority.bind(call('book_appointment'));

    const result = authority.observe(
      bound,
      execution({
        modelOutput: JSON.stringify({
          ok: false,
          message: 'The requested action could not be completed.',
        }),
        status: 'failed',
      }),
    );

    expect(result.handoffRequested).toBe(true);
    expect(authority.bind(call('book_appointment')).arguments).toBe('{}');
  });

  it('forces review when the failed mutation payload is malformed', () => {
    const authority = preparedAuthority();
    const result = authority.observe(
      authority.bind(call('book_appointment')),
      execution({ modelOutput: 'not-json', status: 'failed' }),
    );

    expect(result.handoffRequested).toBe(true);
    expect(JSON.parse(result.modelOutput)).toEqual({
      ok: false,
      message: 'The tool result could not be represented safely.',
    });
  });

  it('does not invent review for a trusted classified refusal', () => {
    const authority = preparedAuthority();
    const result = authority.observe(
      authority.bind(call('book_appointment')),
      execution({
        modelOutput: JSON.stringify({ outcome: 'confirmation_required' }),
        status: 'failed',
      }),
    );

    expect(result.handoffRequested).toBe(false);
    expect(authority.bind(call('book_appointment')).arguments).toBe(
      JSON.stringify({ booking_intent_id: trustedId }),
    );
  });

  it('preserves an already classified unknown review result', () => {
    const authority = preparedAuthority();
    const result = authority.observe(
      authority.bind(call('book_appointment')),
      execution({
        handoffRequested: true,
        modelOutput: JSON.stringify({ outcome: 'unknown' }),
        status: 'failed',
      }),
    );

    expect(result.handoffRequested).toBe(true);
    expect(authority.bind(call('book_appointment')).arguments).toBe('{}');
  });
});
