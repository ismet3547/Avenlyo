import type { BookingAppointmentType, BookingResource } from '../scheduling/types';

import { array, boolean, items, record, string } from './schemas';
import type { EzyVetClient } from './client';

function providerObject(value: unknown, names: readonly string[]): Record<string, unknown> {
  const source = record(value);
  for (const name of names) {
    const nested = source[name];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return record(nested);
  }
  return source;
}

function positiveDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 10 && value <= 480
    ? value
    : null;
}

export async function loadAppointmentTypes(
  client: EzyVetClient,
): Promise<readonly BookingAppointmentType[]> {
  const payload = await client.getCore('/v2/appointmenttype', { active: 'true' });
  return items(payload).flatMap((item) => {
    const appointmentType = providerObject(item, [
      'appointmenttype',
      'appointmentType',
      'attributes',
    ]);
    const key = string(appointmentType.uid ?? appointmentType.id);
    const name = string(appointmentType.name);
    const duration = positiveDuration(
      appointmentType.default_duration ??
        appointmentType.defaultDuration ??
        appointmentType.duration,
    );
    return key && name && duration ? [{ defaultDurationMinutes: duration, key, name }] : [];
  });
}

export async function loadCalendarResources(
  client: EzyVetClient,
): Promise<readonly BookingResource[]> {
  const payload = await client.getCore('/v2/resource', { access: 'On Calendar', active: 'true' });
  return items(payload).flatMap((item) => {
    const resource = providerObject(item, ['resource', 'attributes']);
    const key = string(resource.uid ?? resource.id);
    const name = string(resource.name);
    const active = boolean(resource.active);
    const access = string(resource.access ?? resource.calendar_access);
    const separation = string(resource.ownership_id ?? resource.ownershipId);
    // ezyVet requires calendar-enabled resources; ownership is retained by the database sync
    // metadata but never exposed to the model.
    if (
      !key ||
      !name ||
      active === false ||
      access?.toLowerCase() !== 'on calendar' ||
      !separation
    ) {
      return [];
    }
    return [{ key, name, schedulingScopeKey: separation }];
  });
}

export function resourceOwnershipId(value: unknown): string | null {
  const resource = providerObject(value, ['resource', 'attributes']);
  return string(resource.ownership_id ?? resource.ownershipId);
}

export function rawCatalogItems(value: unknown): readonly unknown[] {
  return array(record(value).items ?? record(value).data);
}
