import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { buildMutationConfirmationText } from './mutation-confirmation.js';

describe('Phase 23 deterministic mutation confirmation text', () => {
  it('builds booking text only from the trusted booking snapshot', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          appointment_type_name: 'Consultation',
          booking_intent_id: 'booking-1',
          location_name: 'Main Clinic',
          starts_at: '2026-09-04T11:00:00.000Z',
          subject_name: 'Bella',
          timezone: 'Europe/Istanbul',
        },
      ],
      error: null,
    });

    const text = await buildMutationConfirmationText(
      { rpc } as unknown as SupabaseClient<Database>,
      { actionIntentId: 'booking-1', intent: 'APPOINTMENT_BOOK' },
    );

    expect(text).toContain('Consultation');
    expect(text).toContain('Bella');
    expect(text).toContain('Main Clinic');
    expect(text).toContain('Reply YES to confirm.');
    expect(text).not.toContain('booking-1');
  });

  it('renders cancellation with the exact current appointment target', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          appointment_title: 'Vaccination',
          change_intent_id: 'change-1',
          location_name: 'Main Clinic',
          operation: 'cancel',
          original_starts_at: '2026-09-04T11:00:00.000Z',
          target_starts_at: null,
          timezone: 'Europe/Istanbul',
        },
      ],
      error: null,
    });

    const text = await buildMutationConfirmationText(
      { rpc } as unknown as SupabaseClient<Database>,
      { actionIntentId: 'change-1', intent: 'APPOINTMENT_CANCEL' },
    );

    expect(text).toContain('cancel Vaccination');
    expect(text).toContain('currently scheduled for');
    expect(text).not.toContain('change-1');
  });

  it('renders reschedule as an explicit old-to-new change', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          appointment_title: 'Consultation',
          change_intent_id: 'change-2',
          location_name: 'Main Clinic',
          operation: 'reschedule',
          original_starts_at: '2026-09-04T11:00:00.000Z',
          target_starts_at: '2026-09-05T12:30:00.000Z',
          timezone: 'Europe/Istanbul',
        },
      ],
      error: null,
    });

    const text = await buildMutationConfirmationText(
      { rpc } as unknown as SupabaseClient<Database>,
      { actionIntentId: 'change-2', intent: 'APPOINTMENT_RESCHEDULE' },
    );

    expect(text).toContain(' from ');
    expect(text).toContain(' to ');
    expect(text).toContain('Reply YES to confirm.');
    expect(text).not.toContain('change-2');
  });

  it('fails closed when the trusted snapshot does not match the server-only authority', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          appointment_type_name: 'Consultation',
          booking_intent_id: 'other-booking',
          location_name: 'Main Clinic',
          starts_at: '2026-09-04T11:00:00.000Z',
          subject_name: 'Bella',
          timezone: 'Europe/Istanbul',
        },
      ],
      error: null,
    });

    await expect(
      buildMutationConfirmationText(
        { rpc } as unknown as SupabaseClient<Database>,
        { actionIntentId: 'booking-1', intent: 'APPOINTMENT_BOOK' },
      ),
    ).rejects.toThrow('Prepared booking confirmation is unavailable.');
  });
});
