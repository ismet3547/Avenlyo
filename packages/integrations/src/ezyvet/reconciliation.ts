import type {
  BookingReconciliationRequest,
  BookingReconciliationResult,
} from '../scheduling/types';

import { array, items, record, string } from './schemas';
import type { EzyVetClient } from './client';

function exactAppointmentId(value: unknown, input: BookingReconciliationRequest): string | null {
  const entry = record(value);
  const appointment = record(entry.attributes);
  const relationships = record(entry.relationships);
  const relationshipId = (name: string) => string(record(record(relationships[name]).data).id);
  const id = string(entry.id);
  const start = string(appointment.start_at ?? appointment.startAt);
  const contact = relationshipId('contact');
  const animal = relationshipId('animal');
  const provider = relationshipId('resource');
  const types = array(record(relationships.appointmentType).data)
    .map(record)
    .map((entry) => string(entry.id));
  if (
    !id ||
    start !== input.slot.startAt ||
    contact !== input.customer.key ||
    animal !== input.subject.key ||
    provider !== input.resource.key ||
    appointment.active !== true ||
    !types.includes(input.appointmentType.key)
  )
    return null;
  return id;
}

/**
 * A provider write is never retried. For an unknown outcome, only a unique record matching all
 * immutable booking fields may be reconciled automatically; every other result remains for a human.
 */
export async function reconcileEzyVetBooking(
  client: EzyVetClient,
  input: BookingReconciliationRequest,
): Promise<BookingReconciliationResult> {
  const startsAt = new Date(input.slot.startAt).getTime();
  const payload = await client.getEzyCab('/ezycab/v2.1/appointments', {
    'filter[active][eq]': 'true',
    'filter[resources.uid][in]': input.resource.key,
    'filter[start_at][gte]': new Date(startsAt - 60_000).toISOString(),
    'filter[start_at][lte]': new Date(startsAt + 60_000).toISOString(),
  });
  const appointmentIds = items(payload)
    .map((item) => exactAppointmentId(item, input))
    .filter((value): value is string => value !== null);
  if (appointmentIds.length === 0) return { kind: 'not_found' };
  if (appointmentIds.length !== 1) return { kind: 'ambiguous' };
  const appointmentId = appointmentIds[0];
  if (!appointmentId) return { kind: 'not_found' };
  return {
    kind: 'found',
    appointment: { appointmentKey: appointmentId, providerStatus: 'unconfirmed' },
  };
}
