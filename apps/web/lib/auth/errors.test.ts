import { describe, expect, it } from 'vitest';

import { getSafeAuthError } from './errors';

describe('auth error sanitization', () => {
  it('maps known provider codes without exposing provider details', () => {
    expect(getSafeAuthError('invalid_credentials')).toBe('The email or password is incorrect.');
  });

  it('uses a generic message for unknown provider errors', () => {
    expect(getSafeAuthError('database_connection_details')).toBe(
      'Authentication could not be completed. Try again.',
    );
  });
});
