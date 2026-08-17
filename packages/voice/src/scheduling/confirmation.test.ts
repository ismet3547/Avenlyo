import { describe, expect, it } from 'vitest';

import { hasExplicitBookingConfirmation } from './confirmation';

describe('hasExplicitBookingConfirmation', () => {
  it('accepts a clear caller confirmation but not incidental or absent text', () => {
    expect(hasExplicitBookingConfirmation('Yes, please book that appointment.')).toBe(true);
    expect(hasExplicitBookingConfirmation('What times do you have?')).toBe(false);
    expect(hasExplicitBookingConfirmation(null)).toBe(false);
  });
});
