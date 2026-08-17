import {
  MAX_AVAILABILITY_DATES,
  MAX_AVAILABILITY_RESOURCES,
  MAX_PROVIDER_AVAILABILITY_DATES,
} from '../scheduling/limits';
import type { AvailabilityRequest, AvailabilitySlot } from '../scheduling/types';
import { BookingProviderError } from '../scheduling/errors';

import { array, boolean, items, record, string } from './schemas';
import type { EzyVetClient } from './client';

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function validTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** ezyCAB emits absolute ISO-8601 slot starts. Never reinterpret an explicit provider offset. */
function absoluteStart(start: string): string | null {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(start)
  ) {
    return null;
  }
  const parsed = Date.parse(start);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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
  const relationships = record(slot.relationships);
  const appointmentTypes = array(record(relationships.appointmentType).data)
    .map(record)
    .map((entry) => string(entry.id))
    .filter((id): id is string => id !== null);
  const duration = slot.duration;
  const start = string(slot.start);
  if (
    boolean(slot.available) !== true ||
    duration !== durationMinutes ||
    !appointmentTypes.includes(appointmentTypeKey) ||
    !start
  ) {
    return null;
  }
  const startAt = absoluteStart(start);
  if (!startAt) return null;
  return {
    appointmentTypeKey,
    endAt: new Date(new Date(startAt).getTime() + durationMinutes * 60_000).toISOString(),
    providerDisplayName: resourceName,
    resourceKey,
    startAt,
    timezone,
  };
}

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}

function availabilityFromPayload(
  payload: unknown,
  input: AvailabilityRequest,
  resourceNames: ReadonlyMap<string, string>,
): readonly AvailabilitySlot[] {
  const permittedResources = new Set(input.resources.map((resource) => resource.key));
  const results: AvailabilitySlot[] = [];
  for (const item of items(payload)) {
    const entry = record(item);
    const attributes = record(entry.attributes);
    const resourceKey = string(record(record(entry.relationships).resource).id);
    const date = string(attributes.date);
    const providerTimezone = string(attributes.timezone);
    if (
      !providerTimezone ||
      !validTimeZone(providerTimezone) ||
      providerTimezone !== input.timezone
    ) {
      throw new BookingProviderError('provider_error');
    }
    if (!resourceKey || !date || !permittedResources.has(resourceKey) || !validDate(date)) continue;
    for (const rawSlot of array(attributes.slots)) {
      const normalized = slotFromRecord(
        rawSlot,
        resourceKey,
        input.appointmentType.key,
        input.timezone,
        input.appointmentType.defaultDurationMinutes,
        resourceNames.get(resourceKey) ?? null,
      );
      if (normalized) results.push(normalized);
    }
  }
  return results;
}

/** ezyCAB accepts at most seven dates per request. The public 14-day window is split deterministically. */
export async function loadAvailability(
  client: EzyVetClient,
  input: AvailabilityRequest,
): Promise<readonly AvailabilitySlot[]> {
  if (
    input.dates.length === 0 ||
    input.dates.length > MAX_AVAILABILITY_DATES ||
    input.resources.length === 0 ||
    input.resources.length > MAX_AVAILABILITY_RESOURCES ||
    input.dates.some((date) => !validDate(date)) ||
    !validTimeZone(input.timezone)
  ) {
    throw new BookingProviderError('invalid_request');
  }
  const resourceNames = new Map(input.resources.map((resource) => [resource.key, resource.name]));
  const slots: AvailabilitySlot[] = [];
  for (const dates of chunks(input.dates, MAX_PROVIDER_AVAILABILITY_DATES)) {
    const payload = await client.getEzyCab('/ezycab/availability', {
      'dates[]': dates,
      duration: String(input.appointmentType.defaultDurationMinutes),
      'filter[slots.appointmentType.id][in]': input.appointmentType.key,
      'filter[slots.available][eq]': 'true',
      'resources[]': input.resources.map((resource) => resource.key),
    });
    slots.push(...availabilityFromPayload(payload, input, resourceNames));
  }
  return [
    ...new Map(
      slots.map((slot) => [`${slot.resourceKey}:${slot.startAt}:${slot.appointmentTypeKey}`, slot]),
    ).values(),
  ].sort(
    (left, right) =>
      left.startAt.localeCompare(right.startAt) ||
      left.resourceKey.localeCompare(right.resourceKey),
  );
}
