import type { CreateBookingRequest, CreateBookingResult } from '../scheduling/types';
import { BookingProviderError } from '../scheduling/errors';

import { record, string } from './schemas';
import type { EzyVetClient } from './client';

export async function createEzyVetBooking(
  client: EzyVetClient,
  input: CreateBookingRequest,
): Promise<CreateBookingResult> {
  const customerKey = input.customer.providerKey ?? ('key' in input.customer ? input.customer.key : null);
  const subjectKey = input.subject.providerKey ?? ('key' in input.subject ? input.subject.key : null);
  if (!customerKey || !subjectKey) {
    throw new BookingProviderError('invalid_request');
  }
  const payload = await client.postEzyCab('/ezycab/booking', {
    animal: subjectKey,
    appointmentStatus: 'unconfirmed',
    contact: customerKey,
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
