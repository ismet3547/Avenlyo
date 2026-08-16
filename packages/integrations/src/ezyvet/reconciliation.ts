import type {
  BookingReconciliationRequest,
  BookingReconciliationResult,
} from '../scheduling/types';

import { items, record, string } from './schemas';
import type { EzyVetClient } from './client';

function exactAppointmentId(value: unknown, input: BookingReconciliationRequest): string | null {
  const appointment = record(record(value).appointment ?? value);
  const id = string(appointment.uid ?? appointment.id);
  const start = string(appointment.start_time ?? appointment.startTime ?? appointment.starts_at);
  const contact = string(appointment.contact_uid ?? appointment.contact ?? appointment.contactId);
  const animal = string(appointment.animal_uid ?? appointment.animal ?? appointment.animalId);
  const provider = string(
    appointment.provider_uid ?? appointment.provider ?? appointment.resource_uid,
  );
  const type = string(appointment.appointment_type_uid ?? appointment.type ?? appointment.type_uid);
  if (
    !id ||
    start !== input.slot.startAt ||
    contact !== input.customer.key ||
    animal !== input.subject.key ||
    provider !== input.resource.key ||
    type !== input.appointmentType.key
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
  const payload = await client.get('/v2/appointment', {
    'filter[animal.id][eq]': input.subject.key,
    'filter[contact.id][eq]': input.customer.key,
    'filter[start_time][eq]': input.slot.startAt,
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
