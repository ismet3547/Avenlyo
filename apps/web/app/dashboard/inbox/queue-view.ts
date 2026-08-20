import type { HandoffQueueRow, InboxMessageRow, MemberRole } from '@avenlyo/database';

export const QUEUE_FILTERS = [
  { label: 'Urgent', value: 'urgent' },
  { label: 'Needs attention', value: 'needs_attention' },
  { label: 'Mine', value: 'mine' },
  { label: 'All active', value: 'all_active' },
  { label: 'Resolved', value: 'resolved' },
] as const;

export type QueueFilter = (typeof QUEUE_FILTERS)[number]['value'];

export function normalizeQueueFilter(value: string | string[] | undefined): QueueFilter {
  const candidate = typeof value === 'string' ? value : null;
  const match = QUEUE_FILTERS.find((filter) => filter.value === candidate);
  return match ? match.value : 'all_active';
}

/**
 * Mirrors the operator priority the queue RPC applies, so a row that arrives from a stale cache or
 * a future read model is still displayed in attention order rather than recency order.
 */
export function handoffQueuePriority(row: HandoffQueueRow): number {
  if (row.handoff_is_active && row.handoff_urgency === 'urgent') {
    return row.customer_waiting ? 1 : 2;
  }
  if (row.handoff_is_active) return row.customer_waiting ? 3 : 4;
  if (row.ai_mode === 'human' && row.customer_waiting) return 5;
  return 6;
}

function attentionTime(row: HandoffQueueRow): number | null {
  if (row.handoff_is_active) {
    const anchor = row.waiting_since ?? row.handoff_created_at;
    return anchor ? Date.parse(anchor) : null;
  }
  if (row.ai_mode === 'human' && row.customer_waiting && row.waiting_since) {
    return Date.parse(row.waiting_since);
  }
  return null;
}

/** Oldest waiting or oldest escalation first inside a priority band; recency only for the tail. */
export function compareQueueRows(left: HandoffQueueRow, right: HandoffQueueRow): number {
  const priority = handoffQueuePriority(left) - handoffQueuePriority(right);
  if (priority !== 0) return priority;
  const leftAttention = attentionTime(left);
  const rightAttention = attentionTime(right);
  if (leftAttention !== null && rightAttention !== null && leftAttention !== rightAttention) {
    return leftAttention - rightAttention;
  }
  if (leftAttention !== null && rightAttention === null) return -1;
  if (leftAttention === null && rightAttention !== null) return 1;
  const recency = Date.parse(right.latest_at) - Date.parse(left.latest_at);
  if (recency !== 0) return recency;
  return left.conversation_id.localeCompare(right.conversation_id);
}

export function sortQueueRows(rows: readonly HandoffQueueRow[]): readonly HandoffQueueRow[] {
  return [...rows].sort(compareQueueRows);
}

export interface CustomerWaitingState {
  readonly waiting: boolean;
  readonly since: string | null;
}

/**
 * The same rule the queue applies in SQL, evaluated against a loaded transcript: the customer is
 * waiting when a customer turn is newer than the newest human-authored reply. Automated replies
 * are not human handling, so they never clear the waiting state.
 */
export function deriveCustomerWaiting(messages: readonly InboxMessageRow[]): CustomerWaitingState {
  let lastHumanReplyAt = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    if (message.direction === 'outbound' && message.author_type === 'human') {
      lastHumanReplyAt = Math.max(lastHumanReplyAt, Date.parse(message.created_at));
    }
  }
  let since: string | null = null;
  let sinceAt = Number.POSITIVE_INFINITY;
  for (const message of messages) {
    if (message.direction !== 'inbound' || message.author_type !== 'customer') continue;
    const at = Date.parse(message.created_at);
    if (at > lastHumanReplyAt && at < sinceAt) {
      since = message.created_at;
      sinceAt = at;
    }
  }
  return { since, waiting: since !== null };
}

/**
 * Elapsed waiting time only. Phase 13 has no configured service-level product policy, so the UI
 * deliberately does not colour rows by an invented threshold.
 */
export function formatWaitingDuration(since: string | null, nowMs: number): string | null {
  if (!since) return null;
  const elapsedMinutes = Math.floor((nowMs - Date.parse(since)) / 60_000);
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < 0) return null;
  if (elapsedMinutes < 1) return 'under a minute';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) {
    const minutes = elapsedMinutes % 60;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

export interface OperatorActions {
  readonly canClaim: boolean;
  readonly canReply: boolean;
  readonly canRelease: boolean;
  readonly canResolve: boolean;
  readonly canResumeAi: boolean;
  readonly canTakeOver: boolean;
  readonly ownedByOther: boolean;
}

const NO_ACTIONS: OperatorActions = {
  canClaim: false,
  canReply: false,
  canRelease: false,
  canResolve: false,
  canResumeAi: false,
  canTakeOver: false,
  ownedByOther: false,
};

export interface OperatorViewer {
  readonly canOverrideOwnership: boolean;
}

/** Owner/admin recovery is a server rule; this only decides whether to offer it in the UI. */
export function operatorViewerFromRole(role: MemberRole): OperatorViewer {
  return { canOverrideOwnership: role === 'owner' || role === 'admin' };
}

/**
 * Only the transitions the server would actually accept are offered to the operator. Recovery of a
 * teammate's work is deliberately Release then Claim: an owner/admin never replies over the current
 * owner and never claims on top of them, because neither would transfer ownership honestly.
 */
export function operatorActions(row: HandoffQueueRow, viewer: OperatorViewer): OperatorActions {
  const textCapable = row.channel_type === 'sms' || row.channel_type === 'web';
  if (row.handoff_is_active) {
    if (row.handoff_assigned_to_me) {
      return { ...NO_ACTIONS, canRelease: true, canReply: textCapable, canResolve: true };
    }
    if (row.handoff_is_assigned) {
      return {
        ...NO_ACTIONS,
        canRelease: viewer.canOverrideOwnership,
        canResolve: viewer.canOverrideOwnership,
        ownedByOther: true,
      };
    }
    return { ...NO_ACTIONS, canClaim: true };
  }
  if (row.ai_mode === 'human') {
    if (row.conversation_is_assigned && !row.conversation_assigned_to_me) {
      return { ...NO_ACTIONS, canResumeAi: viewer.canOverrideOwnership, ownedByOther: true };
    }
    return { ...NO_ACTIONS, canReply: textCapable, canResumeAi: true };
  }
  return { ...NO_ACTIONS, canTakeOver: true };
}

/** Never renders an account identifier; teammates are shown by display name only. */
export function assigneeLabel(assignedToMe: boolean, displayName: string | null): string | null {
  if (assignedToMe) return 'Assigned to you';
  if (displayName) return `Assigned to ${displayName}`;
  return null;
}

export function conversationTitle(row: HandoffQueueRow): string {
  return row.contact_name ?? row.contact_phone ?? 'Website visitor';
}

export const QUEUE_ACTION_MESSAGES: Readonly<Record<string, string>> = {
  already_claimed: 'Another teammate already owns this conversation.',
  already_resolved: 'This handoff was already resolved.',
  not_active: 'This handoff is no longer active.',
  owned_by_other: 'Another teammate owns this conversation.',
  reply_failed: 'That reply could not be sent. Check the conversation transport and try again.',
  resolve_handoff_first: 'Resolve the open handoff before resuming AI.',
  unavailable: 'That action is not available for this conversation.',
};
