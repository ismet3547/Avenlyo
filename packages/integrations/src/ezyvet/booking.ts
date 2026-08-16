import type { CreateBookingRequest, CreateBookingResult } from '../scheduling/types';
import { BookingProviderError } from '../scheduling/errors';

import { record, string } from './schemas';
import type { EzyVetClient } from './client';

export async function createEzyVetBooking(
  client: EzyVetClient,
  input: CreateBookingRequest,
): Promise<CreateBookingResult> {
  const payload = await client.post('/ezycab/booking', {
    animal: input.subject.key,
    appointmentStatus: 'unconfirmed',
    contact: input.customer.key,
    description: input.description,
    durationMinutes: input.appointmentType.defaultDurationMinutes,
    provider: input.resource.key,
    startTime: input.slot.startAt,
    type: input.appointmentType.key,
  });
  const root = record(payload);
  const data = record(root.data ?? root);
  const appointmentKey = string(data.appointment ?? data.appointment_uid ?? data.appointmentId);
  if (!appointmentKey) throw new BookingProviderError('provider_state_unknown');
  return { appointmentKey, providerStatus: 'unconfirmed' };
}
