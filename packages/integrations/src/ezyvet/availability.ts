import {
  MAX_AVAILABILITY_DATES,
  MAX_AVAILABILITY_RESOURCES,
} from '../scheduling/limits';
import type { AvailabilityRequest, AvailabilitySlot } from '../scheduling/types';
import { BookingProviderError } from '../scheduling/errors';

import { array, boolean, items, record, string } from './schemas';
import type { EzyVetClient } from './client';

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function iso(value: unknown): string | null {
  const source = string(value);
  return source && Number.isFinite(Date.parse(source)) ? source : null;
}

function slotFromRecord(
  value: unknown,
  resourceKey: string,
  appointmentTypeKey: string,
  timezone: string,
  durationMinutes: number,
  resourceName: string | null,
): AvailabilitySlot | null {
  const slot = record(value);
  if (boolean(slot.available) === false) return null;
  const slotType = string(slot.appointmentType ?? slot.appointment_type ?? slot.appointmentTypeUid);
  if (slotType && slotType !== appointmentTypeKey) return null;
  const startAt = iso(slot.startAt ?? slot.start_at ?? slot.start_time);
  if (!startAt) return null;
  const endAt =
    iso(slot.endAt ?? slot.end_at ?? slot.end_time) ??
    new Date(new Date(startAt).getTime() + durationMinutes * 60_000).toISOString();
  return {
    appointmentTypeKey,
    endAt,
    providerDisplayName: resourceName,
    resourceKey,
    startAt,
    timezone,
  };
}

/** Uses ezyCAB availability's supported repeated resources[] and dates[] query parameters. */
export async function loadAvailability(
  client: EzyVetClient,
  input: AvailabilityRequest,
): Promise<readonly AvailabilitySlot[]> {
  if (
    input.dates.length === 0 ||
    input.dates.length > MAX_AVAILABILITY_DATES ||
    input.resources.length === 0 ||
    input.resources.length > MAX_AVAILABILITY_RESOURCES ||
    input.dates.some((date) => !validDate(date))
  ) {
    throw new BookingProviderError('invalid_request');
  }
  const payload = await client.get('/ezycab/availability', {
    'dates[]': input.dates,
    duration: String(input.appointmentType.defaultDurationMinutes),
    'filter[slots.appointmentType.id][in]': input.appointmentType.key,
    'filter[slots.available][eq]': 'true',
    'resources[]': input.resources.map((resource) => resource.key),
  });
  const byResource = new Map(input.resources.map((resource) => [resource.key, resource.name]));
  const permittedResources = new Set(input.resources.map((resource) => resource.key));
  const results: AvailabilitySlot[] = [];
  for (const item of items(payload)) {
    const entry = record(item);
    const attributes = record(entry.attributes ?? entry.availability ?? entry);
    const relationships = record(entry.relationships ?? {});
    const resourceRelationship = record(relationships.resource ?? {});
    const resourceKey = string(
      resourceRelationship.id ?? attributes.resource_uid ?? attributes.resourceUid,
    );
    if (!resourceKey || !permittedResources.has(resourceKey)) continue;
    const rawSlots = array(attributes.slots ?? entry.slots);
    for (const rawSlot of rawSlots) {
      const normalized = slotFromRecord(
        rawSlot,
        resourceKey,
        input.appointmentType.key,
        input.timezone,
        input.appointmentType.defaultDurationMinutes,
        byResource.get(resourceKey) ?? null,
      );
      if (normalized) results.push(normalized);
    }
  }
  return results.sort((left, right) => left.startAt.localeCompare(right.startAt));
}
