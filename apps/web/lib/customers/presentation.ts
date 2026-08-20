import type { CustomerTimelineEventKind } from '@avenlyo/database';

/**
 * Presentation rules for customer history.
 *
 * Pure functions so the labelling can be asserted directly. Nothing here invents state: every label
 * maps a value the database already stores onto wording an operator can read. There is no customer
 * lifecycle, no score, and no summary, because none of those exist as canonical truth.
 */

/** Deterministic fallback, mirroring the database function so both surfaces agree. */
export function customerDisplayName(input: {
  readonly email?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly phone?: string | null;
}): string {
  const name = [input.firstName, input.lastName]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join(' ');
  if (name.length > 0) return name;
  const phone = input.phone?.trim();
  if (phone) return phone;
  const email = input.email?.trim();
  if (email) return email;
  return 'Customer';
}

export const CONVERSATION_CHANNELS = ['sms', 'web', 'voice'] as const;
export const CONVERSATION_STATUSES = ['open', 'pending', 'closed'] as const;

export type ConversationChannelFilter = (typeof CONVERSATION_CHANNELS)[number];
export type ConversationStatusFilter = (typeof CONVERSATION_STATUSES)[number];

/** Only canonical values reach the database; anything else is dropped rather than passed through. */
export function parseChannelFilter(
  value: string | null | undefined,
): ConversationChannelFilter | null {
  return CONVERSATION_CHANNELS.includes(value as ConversationChannelFilter)
    ? (value as ConversationChannelFilter)
    : null;
}

export function parseStatusFilter(
  value: string | null | undefined,
): ConversationStatusFilter | null {
  return CONVERSATION_STATUSES.includes(value as ConversationStatusFilter)
    ? (value as ConversationStatusFilter)
    : null;
}

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  phone: 'Phone',
  sms: 'SMS',
  voice: 'Voice',
  web: 'Web chat',
};

export function channelLabel(channel: string | null | undefined): string {
  return CHANNEL_LABELS[channel ?? ''] ?? 'Conversation';
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  closed: 'Closed',
  open: 'Open',
  pending: 'Pending',
};

export function conversationStatusLabel(status: string | null | undefined): string {
  return STATUS_LABELS[status ?? ''] ?? 'Unknown';
}

/**
 * Message author, from durable columns only.
 *
 * Never inferred from the text: a customer quoting the assistant does not become the assistant.
 */
export function messageAuthorLabel(input: {
  readonly authorDisplayName?: string | null;
  readonly authorType: string;
}): string {
  switch (input.authorType) {
    case 'customer':
      return 'Customer';
    case 'ai':
      return 'Avenlyo AI';
    case 'human':
      // A teammate whose access was later removed still has their preserved profile name here.
      return input.authorDisplayName?.trim() || 'Teammate';
    default:
      return 'System';
  }
}

/**
 * Delivery state, presented without softening it.
 *
 * `unknown` is the one that matters. Phase 7 made it deliberately ambiguous: the provider may or
 * may not have delivered the message, and relabelling it "sent" or "failed" would invite somebody
 * to resend a message the customer already received.
 */
const DELIVERY_LABELS: Readonly<Record<string, string>> = {
  delivered: 'Delivered',
  failed: 'Failed',
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  undelivered: 'Undelivered',
  unknown: 'Delivery unconfirmed',
};

export type DeliveryTone = 'failed' | 'neutral' | 'success' | 'warning';

export function deliveryLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  return DELIVERY_LABELS[status] ?? 'Delivery unconfirmed';
}

/** Tone is supplementary. Every state also carries its own words, never colour alone. */
export function deliveryTone(status: string | null | undefined): DeliveryTone {
  switch (status) {
    case 'delivered':
    case 'sent':
      return 'success';
    case 'failed':
    case 'undelivered':
      return 'failed';
    case 'unknown':
      return 'warning';
    default:
      return 'neutral';
  }
}

const TIMELINE_LABELS: Readonly<Record<CustomerTimelineEventKind, string>> = {
  appointment: 'Appointment',
  call: 'Call',
  conversation: 'Conversation',
  handoff: 'Human handoff',
  lead: 'Lead',
};

export function timelineEventLabel(kind: CustomerTimelineEventKind): string {
  return TIMELINE_LABELS[kind] ?? 'Activity';
}

const LEAD_STATUS_LABELS: Readonly<Record<string, string>> = {
  converted: 'Converted',
  lost: 'Lost',
  new: 'New',
  qualified: 'Qualified',
};

export function leadStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  return LEAD_STATUS_LABELS[status] ?? 'Lead';
}

const APPOINTMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  cancelled: 'Cancelled',
  completed: 'Completed',
  confirmed: 'Confirmed',
  requested: 'Requested',
};

export function appointmentStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  return APPOINTMENT_STATUS_LABELS[status] ?? 'Scheduled';
}

const CALL_STATUS_LABELS: Readonly<Record<string, string>> = {
  completed: 'Completed',
  failed: 'Did not connect',
  initiated: 'Started',
  ringing: 'Ringing',
};

export function callStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  return CALL_STATUS_LABELS[status] ?? 'Call';
}

/** Whole minutes, or null when the call never completed. Never a fabricated duration. */
export function callDurationMinutes(
  startedAt: string | null,
  endedAt: string | null,
): number | null {
  if (!startedAt || !endedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.max(1, Math.round((end - start) / 60_000));
}
