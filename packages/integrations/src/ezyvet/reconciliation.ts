import type {
  BookingReconciliationRequest,
  BookingReconciliationResult,
} from '../scheduling/types';

import { array, boolean, items, record, string } from './schemas';
import type { EzyVetClient } from './client';

const RECONCILIATION_PAGE_SIZE = 50;

function epochStart(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value * 1_000).toISOString()
    : null;
}

function exactAppointmentUid(value: unknown, input: BookingReconciliationRequest): string | null {
  const appointment = record(value);
  const uid = string(appointment.uid);
  const startAt = epochStart(appointment.start_at);
  const typeUid = string(appointment.type_uid);
  const animalUid = string(appointment.animal_uid);
  const contactUid = string(appointment.contact_uid);
  const subjectKey = input.subject.providerKey ?? ('key' in input.subject ? input.subject.key : null);
  const customerKey = input.customer.providerKey ?? ('key' in input.customer ? input.customer.key : null);
  const hasResource = array(appointment.resources).some(
    (resource) => string(record(resource).uid) === input.resource.key,
  );
  if (
    !uid ||
    boolean(appointment.active) !== true ||
    startAt !== input.slot.startAt ||
    typeUid !== input.appointmentType.key ||
    animalUid !== subjectKey ||
    contactUid !== customerKey ||
    !hasResource
  ) {
    return null;
  }
  return uid;
}

/**
 * A provider write is never retried. A narrow read can resolve only one exact provider UID;
 * unread pages are deliberately ambiguous rather than being treated as a unique booking.
 */
export async function reconcileEzyVetBooking(
  client: EzyVetClient,
  input: BookingReconciliationRequest,
): Promise<BookingReconciliationResult> {
  const startsAt = new Date(input.slot.startAt).getTime();
  const payload = await client.getEzyCab('/ezycab/v2.1/appointments', {
    'filter[active][eq]': 'true',
    'filter[resources.uid][in]': JSON.stringify([input.resource.key]),
    'filter[start_at][gte]': new Date(startsAt - 60_000).toISOString(),
    'filter[start_at][lte]': new Date(startsAt + 60_000).toISOString(),
    pageSize: String(RECONCILIATION_PAGE_SIZE),
  });
  const root = record(payload);
  const nextToken = string(record(root.meta).nextToken);
  if (nextToken) return { kind: 'ambiguous' };
  const appointmentUids = items(payload)
    .map((item) => exactAppointmentUid(item, input))
    .filter((value): value is string => value !== null);
  if (appointmentUids.length === 0) return { kind: 'not_found' };
  if (appointmentUids.length !== 1) return { kind: 'ambiguous' };
  return {
    kind: 'found',
    appointment: { appointmentKey: appointmentUids[0]!, providerStatus: 'unconfirmed' },
  };
}
