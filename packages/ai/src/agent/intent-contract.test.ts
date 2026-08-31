import { describe, expect, it } from 'vitest';

import {
  customerIntentNames,
  highestPrecedenceIntent,
  intentOperatingInstructions,
  intentPrecedenceTier,
  isInterruptIntent,
  isMutatingCustomerIntent,
} from './intent-contract';

describe('Phase 23 intent operating contract', () => {
  it('keeps lead as a business outcome rather than a customer intent', () => {
    expect(customerIntentNames).not.toContain('LEAD');
    expect(intentOperatingInstructions).toContain('LEAD is not a customer intent');
  });

  it('gives interrupts precedence over appointment mutations', () => {
    expect(highestPrecedenceIntent(['APPOINTMENT_BOOK', 'HUMAN_REQUEST'])).toBe(
      'HUMAN_REQUEST',
    );
    expect(isInterruptIntent('SAFETY_ESCALATION')).toBe(true);
    expect(intentPrecedenceTier('HUMAN_REQUEST')).toBe('interrupt');
  });

  it('gives a pending confirmation response precedence over lower-risk new work', () => {
    expect(
      highestPrecedenceIntent(['BUSINESS_INFORMATION', 'CONFIRMATION_RESPONSE']),
    ).toBe('CONFIRMATION_RESPONSE');
  });

  it('gives appointment mutations precedence over read-only work while preserving tier order', () => {
    expect(
      highestPrecedenceIntent([
        'BUSINESS_INFORMATION',
        'APPOINTMENT_CANCEL',
        'APPOINTMENT_BOOK',
      ]),
    ).toBe('APPOINTMENT_CANCEL');
    expect(isMutatingCustomerIntent('APPOINTMENT_RESCHEDULE')).toBe(true);
    expect(isMutatingCustomerIntent('APPOINTMENT_LOOKUP')).toBe(false);
  });

  it('documents the one-pending-mutation and intent-is-not-permission invariants', () => {
    expect(intentOperatingInstructions).toContain(
      'At most one consequential mutation may be pending confirmation at a time.',
    );
    expect(intentOperatingInstructions).toContain('Intent is not permission.');
    expect(intentOperatingInstructions).toContain(
      'One ambiguous “yes” never authorizes multiple mutations.',
    );
  });
});
