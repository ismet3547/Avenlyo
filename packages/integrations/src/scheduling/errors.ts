export type BookingErrorCategory =
  | 'authentication'
  | 'authorization_scope'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'invalid_request'
  | 'not_found'
  | 'slot_unavailable'
  | 'provider_state_unknown'
  | 'provider_conflict'
  | 'provider_error';

export class BookingProviderError extends Error {
  public constructor(
    public readonly category: BookingErrorCategory,
    message = 'The scheduling provider could not complete the request.',
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'BookingProviderError';
  }
}

export function providerErrorForStatus(status: number, bookingWrite = false): BookingProviderError {
  if (status === 401) return new BookingProviderError('authentication');
  if (status === 403) return new BookingProviderError('authorization_scope');
  if (status === 404) return new BookingProviderError('not_found');
  if (status === 409) return new BookingProviderError(bookingWrite ? 'provider_conflict' : 'slot_unavailable');
  if (status === 412) return new BookingProviderError('provider_conflict');
  if (status === 429) return new BookingProviderError('rate_limit', undefined, !bookingWrite);
  if (status >= 500) {
    return new BookingProviderError(
      bookingWrite ? 'provider_state_unknown' : 'provider_error',
      undefined,
      !bookingWrite,
    );
  }
  return new BookingProviderError('invalid_request');
}
