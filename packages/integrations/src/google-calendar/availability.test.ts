import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { createGoogleAvailabilitySlots, SLOT_GRID_MINUTES } from './availability';

const hours = {
  monday: { closed: false, open: '09:00', close: '17:00' },
  tuesday: { closed: true, open: null, close: null },
  wednesday: { closed: true, open: null, close: null },
  thursday: { closed: true, open: null, close: null },
  friday: { closed: true, open: null, close: null },
  saturday: { closed: true, open: null, close: null },
  sunday: { closed: false, open: '01:00', close: '04:00' },
} as const;
const resource = { key: 'calendar_1', name: 'Room One', schedulingScopeKey: null };
const type = { defaultDurationMinutes: 45, key: 'consultation', name: 'Consultation' };

describe('Google Calendar availability', () => {
  it('intersects business hours, minimum lead, merged busy time, and whole duration', () => {
    const slots = createGoogleAvailabilitySlots({
      appointmentType: type,
      businessHours: hours,
      busyByResource: new Map([
        [
          resource.key,
          [
            { start: '2026-09-07T08:30:00Z', end: '2026-09-07T08:45:00Z' },
            { start: '2026-09-07T08:45:00Z', end: '2026-09-07T09:00:00Z' },
          ],
        ],
      ]),
      dates: ['2026-09-07'],
      minimumLeadMinutes: 60,
      now: Temporal.Instant.from('2026-09-07T07:20:00Z'),
      resources: [resource],
      timezone: 'Europe/London',
    });
    expect(SLOT_GRID_MINUTES).toBe(15);
    expect(slots).toHaveLength(5);
    expect(slots.every((slot) => slot.startAt >= '2026-09-07T08:20:00Z')).toBe(true);
    expect(slots[0]?.startAt).toBe('2026-09-07T09:00:00Z');
    expect(slots.some((slot) => slot.startAt === '2026-09-07T08:15:00Z')).toBe(false);
  });

  it('skips nonexistent spring-forward wall times without duplicate absolute slots', () => {
    const spring = createGoogleAvailabilitySlots({
      appointmentType: { ...type, defaultDurationMinutes: 30 },
      businessHours: hours,
      busyByResource: new Map(),
      dates: ['2026-03-29'],
      minimumLeadMinutes: 0,
      now: Temporal.Instant.from('2026-03-28T00:00:00Z'),
      resources: [resource],
      timezone: 'Europe/London',
    });
    expect(spring[0]?.startAt).toBe('2026-03-29T01:00:00Z');
    expect(new Set(spring.map((slot) => `${slot.startAt}:${slot.endAt}`)).size).toBe(spring.length);
    expect(spring.some((slot) => slot.startAt === '2026-03-29T00:00:00Z')).toBe(false);
  });

  it('chooses the earlier fall-back occurrence and keeps model-facing slots unique', () => {
    const fall = createGoogleAvailabilitySlots({
      appointmentType: { ...type, defaultDurationMinutes: 30 },
      businessHours: hours,
      busyByResource: new Map(),
      dates: ['2026-10-25'],
      minimumLeadMinutes: 0,
      now: Temporal.Instant.from('2026-10-24T00:00:00Z'),
      resources: [resource],
      timezone: 'Europe/London',
    });
    expect(fall[0]?.startAt).toBe('2026-10-25T00:00:00Z');
    expect(
      new Set(
        fall.map(
          (slot) => `${slot.resourceKey}:${slot.startAt}:${slot.endAt}:${slot.appointmentTypeKey}`,
        ),
      ).size,
    ).toBe(fall.length);
    expect(
      fall.every((slot) => Date.parse(slot.endAt) - Date.parse(slot.startAt) === 30 * 60_000),
    ).toBe(true);
  });
});
