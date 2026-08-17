import { Temporal } from '@js-temporal/polyfill';

import type { AvailabilitySlot, BookingAppointmentType, BookingResource } from '../scheduling/types';

import type { GoogleBusyPeriod } from './types';

const MAX_SLOTS = 5;
const SLOT_GRID_MINUTES = 15;

export interface GoogleBusinessHours {
  readonly [day: string]: { readonly close: string | null; readonly closed: boolean; readonly open: string | null };
}

function minutes(value: string): number | null {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value);
  return match ? Number(match[0].slice(0, 2)) * 60 + Number(match[0].slice(3, 5)) : null;
}
function dayName(date: Temporal.PlainDate): string {
  return ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][date.dayOfWeek - 1] ?? 'monday';
}
function localInstant(date: Temporal.PlainDate, minute: number, timezone: string): Temporal.Instant {
  return Temporal.ZonedDateTime.from({
    timeZone: timezone, year: date.year, month: date.month, day: date.day,
    hour: Math.floor(minute / 60), minute: minute % 60,
  }, { disambiguation: 'compatible' }).toInstant();
}
function mergeBusy(ranges: readonly GoogleBusyPeriod[]): readonly { readonly end: number; readonly start: number }[] {
  const ordered = ranges.map((range) => ({ start: Date.parse(range.start), end: Date.parse(range.end) }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const result: { end: number; start: number }[] = [];
  for (const range of ordered) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}
function wholeSlotFree(start: number, end: number, busy: readonly { readonly end: number; readonly start: number }[]): boolean {
  return busy.every((range) => end <= range.start || start >= range.end);
}

/** Produces local-time business-hour slots while treating Google busy ranges as absolute instants. */
export function createGoogleAvailabilitySlots(input: {
  readonly appointmentType: BookingAppointmentType;
  readonly businessHours: GoogleBusinessHours;
  readonly busyByResource: ReadonlyMap<string, readonly GoogleBusyPeriod[]>;
  readonly dates: readonly string[];
  readonly minimumLeadMinutes: number;
  readonly now?: Temporal.Instant;
  readonly resources: readonly BookingResource[];
  readonly timezone: string;
}): readonly AvailabilitySlot[] {
  const now = input.now ?? Temporal.Now.instant();
  const earliest = now.add({ minutes: input.minimumLeadMinutes }).epochMilliseconds;
  const result: AvailabilitySlot[] = [];
  for (const dateText of input.dates) {
    const date = Temporal.PlainDate.from(dateText);
    const hours = input.businessHours[dayName(date)];
    const opening = hours?.open ? minutes(hours.open) : null;
    const closing = hours?.close ? minutes(hours.close) : null;
    if (hours?.closed || opening === null || closing === null || closing <= opening) continue;
    for (const resource of input.resources) {
      const busy = mergeBusy(input.busyByResource.get(resource.key) ?? []);
      for (let minute = opening; minute + input.appointmentType.defaultDurationMinutes <= closing; minute += SLOT_GRID_MINUTES) {
        const start = localInstant(date, minute, input.timezone);
        const end = localInstant(date, minute + input.appointmentType.defaultDurationMinutes, input.timezone);
        if (start.epochMilliseconds < earliest || end.epochMilliseconds <= start.epochMilliseconds) continue;
        if (!wholeSlotFree(start.epochMilliseconds, end.epochMilliseconds, busy)) continue;
        result.push({ appointmentTypeKey: input.appointmentType.key, endAt: end.toString(), providerDisplayName: resource.name, resourceKey: resource.key, startAt: start.toString(), timezone: input.timezone });
        if (result.length >= MAX_SLOTS) return result;
      }
    }
  }
  return result;
}

export { MAX_SLOTS as MAX_GOOGLE_MODEL_SLOTS, SLOT_GRID_MINUTES };
