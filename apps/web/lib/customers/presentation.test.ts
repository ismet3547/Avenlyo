import { describe, expect, it } from 'vitest';

import {
  appointmentStatusLabel,
  callDurationMinutes,
  callStatusLabel,
  channelLabel,
  conversationStatusLabel,
  customerDisplayName,
  deliveryLabel,
  deliveryTone,
  leadStatusLabel,
  messageAuthorLabel,
  parseChannelFilter,
  parseStatusFilter,
  timelineEventLabel,
} from './presentation';

/**
 * Customer history presentation.
 *
 * Every label maps a value the database already stores. Nothing here invents a customer status, and
 * the assertions exist mostly to keep it that way.
 */
describe('customer display name', () => {
  it('falls back deterministically through name, phone, and email', () => {
    expect(customerDisplayName({ firstName: 'Robin', lastName: 'Shared' })).toBe('Robin Shared');
    expect(customerDisplayName({ firstName: 'Robin' })).toBe('Robin');
    expect(customerDisplayName({ lastName: 'Shared' })).toBe('Shared');
    expect(customerDisplayName({ phone: '+15405550101' })).toBe('+15405550101');
    expect(customerDisplayName({ email: 'robin@customer.test' })).toBe('robin@customer.test');
    expect(customerDisplayName({})).toBe('Customer');
  });

  it('ignores whitespace-only identity fields rather than rendering a blank name', () => {
    expect(customerDisplayName({ firstName: '  ', lastName: '  ', phone: '+15405550101' })).toBe(
      '+15405550101',
    );
    expect(customerDisplayName({ firstName: '', phone: '', email: '' })).toBe('Customer');
  });
});

describe('message author attribution', () => {
  it('derives the author from durable columns only', () => {
    expect(messageAuthorLabel({ authorType: 'customer' })).toBe('Customer');
    expect(messageAuthorLabel({ authorType: 'ai' })).toBe('Avenlyo AI');
    expect(messageAuthorLabel({ authorType: 'system' })).toBe('System');
    expect(messageAuthorLabel({ authorDisplayName: 'Dana', authorType: 'human' })).toBe('Dana');
  });

  it('still names a human message whose author has no resolvable display name', () => {
    // A since-revoked teammate normally resolves through their preserved profile row; this is the
    // fallback for the case where even that is absent.
    expect(messageAuthorLabel({ authorDisplayName: null, authorType: 'human' })).toBe('Teammate');
    expect(messageAuthorLabel({ authorDisplayName: '   ', authorType: 'human' })).toBe('Teammate');
  });
});

describe('delivery truth', () => {
  it('presents each canonical state without softening it', () => {
    expect(deliveryLabel('queued')).toBe('Queued');
    expect(deliveryLabel('sent')).toBe('Sent');
    expect(deliveryLabel('delivered')).toBe('Delivered');
    expect(deliveryLabel('failed')).toBe('Failed');
    expect(deliveryLabel('undelivered')).toBe('Undelivered');
  });

  it('keeps an unknown delivery visibly ambiguous', () => {
    // Relabelling this "sent" or "failed" would invite someone to resend a message the customer may
    // already have received. Phase 7 made the state ambiguous on purpose.
    const label = deliveryLabel('unknown');
    expect(label).toBe('Delivery unconfirmed');
    expect(label).not.toBe('Sent');
    expect(label).not.toBe('Failed');
    expect(deliveryTone('unknown')).toBe('warning');
  });

  it('returns nothing for a message with no delivery record', () => {
    expect(deliveryLabel(null)).toBeNull();
    expect(deliveryLabel(undefined)).toBeNull();
  });

  it('always carries words, so state is never conveyed by colour alone', () => {
    for (const status of [
      'queued',
      'sending',
      'sent',
      'delivered',
      'failed',
      'undelivered',
      'unknown',
    ]) {
      expect(deliveryLabel(status)?.length).toBeGreaterThan(0);
    }
  });
});

describe('conversation filters', () => {
  it('accepts only canonical channel and status values', () => {
    expect(parseChannelFilter('sms')).toBe('sms');
    expect(parseChannelFilter('web')).toBe('web');
    expect(parseChannelFilter('voice')).toBe('voice');
    expect(parseStatusFilter('open')).toBe('open');
    expect(parseStatusFilter('pending')).toBe('pending');
    expect(parseStatusFilter('closed')).toBe('closed');
  });

  it('drops anything invented rather than forwarding it to the database', () => {
    for (const hostile of [
      'telepathy',
      'archived',
      'ALL',
      '',
      null,
      undefined,
      'sms; drop table',
    ]) {
      expect(parseChannelFilter(hostile)).toBeNull();
      expect(parseStatusFilter(hostile)).toBeNull();
    }
  });
});

describe('operator-facing labels', () => {
  it('names channels, statuses, and events in product language', () => {
    expect(channelLabel('sms')).toBe('SMS');
    expect(channelLabel('web')).toBe('Web chat');
    expect(channelLabel('voice')).toBe('Voice');
    expect(conversationStatusLabel('open')).toBe('Open');
    expect(timelineEventLabel('handoff')).toBe('Human handoff');
    expect(timelineEventLabel('conversation')).toBe('Conversation');
    expect(leadStatusLabel('qualified')).toBe('Qualified');
    expect(appointmentStatusLabel('confirmed')).toBe('Confirmed');
    expect(callStatusLabel('failed')).toBe('Did not connect');
  });

  it('never surfaces a raw internal identifier as prose', () => {
    // An unrecognised value gets a safe generic label rather than being printed verbatim.
    expect(channelLabel('provider_state_unknown')).toBe('Conversation');
    expect(conversationStatusLabel('provider_state_unknown')).toBe('Unknown');
    expect(leadStatusLabel('provider_state_unknown')).toBe('Lead');
    expect(appointmentStatusLabel('provider_state_unknown')).toBe('Scheduled');
  });

  it('omits a label entirely when there is no value to describe', () => {
    expect(leadStatusLabel(null)).toBeNull();
    expect(appointmentStatusLabel(null)).toBeNull();
    expect(callStatusLabel(null)).toBeNull();
  });
});

describe('call duration', () => {
  it('reports whole minutes for a completed call', () => {
    expect(callDurationMinutes('2026-08-20T10:00:00.000Z', '2026-08-20T10:04:00.000Z')).toBe(4);
  });

  it('never fabricates a duration', () => {
    expect(callDurationMinutes('2026-08-20T10:00:00.000Z', null)).toBeNull();
    expect(callDurationMinutes(null, '2026-08-20T10:04:00.000Z')).toBeNull();
    expect(callDurationMinutes('not-a-date', '2026-08-20T10:04:00.000Z')).toBeNull();
    // An end before the start is corrupt rather than negative.
    expect(callDurationMinutes('2026-08-20T10:04:00.000Z', '2026-08-20T10:00:00.000Z')).toBeNull();
  });
});
