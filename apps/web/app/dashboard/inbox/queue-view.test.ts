import type { HandoffQueueRow, InboxMessageRow } from '@avenlyo/database';
import { describe, expect, it } from 'vitest';

import {
  QUEUE_ACTION_MESSAGES,
  assigneeLabel,
  compareQueueRows,
  deriveCustomerWaiting,
  formatWaitingDuration,
  handoffQueuePriority,
  normalizeQueueFilter,
  operatorActions,
  operatorViewerFromRole,
  sortQueueRows,
} from './queue-view';

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const MEMBER = operatorViewerFromRole('member');
const ADMIN = operatorViewerFromRole('admin');

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function daysAgo(days: number): string {
  return minutesAgo(days * 24 * 60);
}

function queueRow(overrides: Partial<HandoffQueueRow> = {}): HandoffQueueRow {
  return {
    ai_mode: 'ai',
    channel_type: 'sms',
    contact_name: 'Casey Customer',
    contact_phone: '+15105550101',
    conversation_assigned_name: null,
    conversation_assigned_to_me: false,
    conversation_id: '11111111-1111-4111-8111-111111111111',
    conversation_is_assigned: false,
    customer_waiting: false,
    handoff_assigned_name: null,
    handoff_assigned_to_me: false,
    handoff_call_status: null,
    handoff_created_at: null,
    handoff_first_acknowledged_at: null,
    handoff_id: null,
    handoff_is_active: false,
    handoff_is_assigned: false,
    handoff_reason: null,
    handoff_resolved_at: null,
    handoff_source: null,
    handoff_status: null,
    handoff_urgency: null,
    latest_at: minutesAgo(1),
    latest_body: 'Hello',
    lead_status: null,
    lead_urgency: null,
    location_id: '22222222-2222-4222-8222-222222222222',
    queue_priority: 6,
    waiting_since: null,
    ...overrides,
  };
}

function activeHandoffRow(
  id: string,
  urgency: 'normal' | 'urgent',
  waitingMinutes: number | null,
  overrides: Partial<HandoffQueueRow> = {},
): HandoffQueueRow {
  return queueRow({
    ai_mode: 'human',
    conversation_id: id,
    customer_waiting: waitingMinutes !== null,
    handoff_created_at: minutesAgo(60),
    handoff_id: `${id.slice(0, 8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    handoff_is_active: true,
    handoff_reason: 'Customer asked for a person.',
    handoff_source: 'message',
    handoff_status: 'open',
    handoff_urgency: urgency,
    waiting_since: waitingMinutes === null ? null : minutesAgo(waitingMinutes),
    ...overrides,
  });
}

function message(overrides: Partial<InboxMessageRow>): InboxMessageRow {
  return {
    author_type: 'customer',
    body: 'text',
    created_at: minutesAgo(5),
    delivery_status: null,
    direction: 'inbound',
    message_id: '33333333-3333-4333-8333-333333333333',
    source_channel: 'sms',
    ...overrides,
  };
}

describe('operator queue priority and ordering', () => {
  it('ranks urgent waiting work above every other operational state', () => {
    expect(handoffQueuePriority(activeHandoffRow('a', 'urgent', 10))).toBe(1);
    expect(handoffQueuePriority(activeHandoffRow('b', 'urgent', null))).toBe(2);
    expect(handoffQueuePriority(activeHandoffRow('c', 'normal', 10))).toBe(3);
    expect(handoffQueuePriority(activeHandoffRow('d', 'normal', null))).toBe(4);
    expect(
      handoffQueuePriority(
        queueRow({ ai_mode: 'human', customer_waiting: true, waiting_since: minutesAgo(4) }),
      ),
    ).toBe(5);
    expect(handoffQueuePriority(queueRow())).toBe(6);
  });

  it('sorts urgent before normal and waiting before non-waiting inside a band', () => {
    const rows = [
      queueRow({ conversation_id: 'f0000000-0000-4000-8000-000000000000' }),
      activeHandoffRow('d0000000-0000-4000-8000-000000000000', 'normal', null),
      activeHandoffRow('c0000000-0000-4000-8000-000000000000', 'normal', 10),
      activeHandoffRow('b0000000-0000-4000-8000-000000000000', 'urgent', null),
      activeHandoffRow('a0000000-0000-4000-8000-000000000000', 'urgent', 10),
    ];

    expect(sortQueueRows(rows).map((row) => row.conversation_id)).toEqual([
      'a0000000-0000-4000-8000-000000000000',
      'b0000000-0000-4000-8000-000000000000',
      'c0000000-0000-4000-8000-000000000000',
      'd0000000-0000-4000-8000-000000000000',
      'f0000000-0000-4000-8000-000000000000',
    ]);
  });

  it('puts the longest waiting customer first inside the same priority band', () => {
    const older = activeHandoffRow('a0000000-0000-4000-8000-000000000000', 'urgent', 45);
    const newer = activeHandoffRow('b0000000-0000-4000-8000-000000000000', 'urgent', 5);

    expect(compareQueueRows(older, newer)).toBeLessThan(0);
    expect(compareQueueRows(newer, older)).toBeGreaterThan(0);
  });

  it('falls back to recency only for conversations that need nobody', () => {
    const recent = queueRow({
      conversation_id: 'a0000000-0000-4000-8000-000000000000',
      latest_at: minutesAgo(1),
    });
    const stale = queueRow({
      conversation_id: 'b0000000-0000-4000-8000-000000000000',
      latest_at: minutesAgo(90),
    });

    expect(sortQueueRows([stale, recent]).map((row) => row.conversation_id)).toEqual([
      'a0000000-0000-4000-8000-000000000000',
      'b0000000-0000-4000-8000-000000000000',
    ]);
  });
});

describe('queue filters', () => {
  it('accepts only the operational filters the read model implements', () => {
    expect(normalizeQueueFilter('urgent')).toBe('urgent');
    expect(normalizeQueueFilter('needs_attention')).toBe('needs_attention');
    expect(normalizeQueueFilter('mine')).toBe('mine');
    expect(normalizeQueueFilter('resolved')).toBe('resolved');
  });

  it('falls back to the default view for unknown or missing input', () => {
    expect(normalizeQueueFilter(undefined)).toBe('all_active');
    expect(normalizeQueueFilter('kanban')).toBe('all_active');
    expect(normalizeQueueFilter(['urgent'])).toBe('all_active');
  });
});

describe('customer waiting derivation', () => {
  it('waits from the oldest customer turn no human has answered inside the episode', () => {
    const state = deriveCustomerWaiting(
      [
        message({ created_at: minutesAgo(40), message_id: 'm1' }),
        message({
          author_type: 'human',
          created_at: minutesAgo(30),
          direction: 'outbound',
          message_id: 'm2',
        }),
        message({ created_at: minutesAgo(20), message_id: 'm3' }),
        message({ created_at: minutesAgo(10), message_id: 'm4' }),
      ],
      minutesAgo(40),
    );

    expect(state.waiting).toBe(true);
    expect(state.since).toBe(minutesAgo(20));
  });

  it('ignores turns automation already answered before the episode opened', () => {
    const state = deriveCustomerWaiting(
      [
        message({ created_at: daysAgo(21), message_id: 'm1' }),
        message({
          author_type: 'ai',
          created_at: daysAgo(21),
          direction: 'outbound',
          message_id: 'm2',
        }),
        message({ created_at: daysAgo(20), message_id: 'm3' }),
        message({ created_at: minutesAgo(4), message_id: 'm4' }),
      ],
      minutesAgo(4),
    );

    expect(state).toEqual({ since: minutesAgo(4), waiting: true });
  });

  it('counts the turn that triggered the escalation as waiting', () => {
    const state = deriveCustomerWaiting(
      [message({ created_at: minutesAgo(4), message_id: 'm1' })],
      minutesAgo(4),
    );

    expect(state).toEqual({ since: minutesAgo(4), waiting: true });
  });

  it('reports nobody waiting when no human episode is open', () => {
    const state = deriveCustomerWaiting(
      [message({ created_at: minutesAgo(4), message_id: 'm1' })],
      null,
    );

    expect(state).toEqual({ since: null, waiting: false });
  });

  it('reports nobody waiting for an episode with no customer turns', () => {
    const state = deriveCustomerWaiting([], minutesAgo(1));

    expect(state).toEqual({ since: null, waiting: false });
  });

  it('does not treat an automated reply as human handling', () => {
    const state = deriveCustomerWaiting(
      [
        message({ created_at: minutesAgo(15), message_id: 'm1' }),
        message({
          author_type: 'ai',
          created_at: minutesAgo(14),
          direction: 'outbound',
          message_id: 'm2',
        }),
      ],
      minutesAgo(15),
    );

    expect(state).toEqual({ since: minutesAgo(15), waiting: true });
  });

  it('ignores a human reply that belongs to a finished episode', () => {
    const state = deriveCustomerWaiting(
      [
        message({ created_at: minutesAgo(60), message_id: 'm1' }),
        message({
          author_type: 'human',
          created_at: minutesAgo(50),
          direction: 'outbound',
          message_id: 'm2',
        }),
        message({ created_at: minutesAgo(5), message_id: 'm3' }),
      ],
      minutesAgo(5),
    );

    expect(state).toEqual({ since: minutesAgo(5), waiting: true });
  });

  it('clears once a human answers the newest customer turn', () => {
    const state = deriveCustomerWaiting(
      [
        message({ created_at: minutesAgo(15), message_id: 'm1' }),
        message({
          author_type: 'human',
          created_at: minutesAgo(2),
          direction: 'outbound',
          message_id: 'm2',
        }),
      ],
      minutesAgo(15),
    );

    expect(state).toEqual({ since: null, waiting: false });
  });

  it('starts waiting again from a customer turn that follows the human reply', () => {
    const state = deriveCustomerWaiting(
      [
        message({ created_at: minutesAgo(15), message_id: 'm1' }),
        message({
          author_type: 'human',
          created_at: minutesAgo(10),
          direction: 'outbound',
          message_id: 'm2',
        }),
        message({ created_at: minutesAgo(3), message_id: 'm3' }),
      ],
      minutesAgo(15),
    );

    expect(state).toEqual({ since: minutesAgo(3), waiting: true });
  });

  it('reports elapsed time without inventing a service-level threshold', () => {
    expect(formatWaitingDuration(minutesAgo(0), NOW)).toBe('under a minute');
    expect(formatWaitingDuration(minutesAgo(12), NOW)).toBe('12m');
    expect(formatWaitingDuration(minutesAgo(65), NOW)).toBe('1h 5m');
    expect(formatWaitingDuration(minutesAgo(60 * 26), NOW)).toBe('1d 2h');
    expect(formatWaitingDuration(null, NOW)).toBeNull();
  });
});

describe('state-driven operator actions', () => {
  it('offers only Claim on an unassigned active handoff', () => {
    const actions = operatorActions(activeHandoffRow('a', 'urgent', 5), MEMBER);

    expect(actions.canClaim).toBe(true);
    expect(actions.canReply).toBe(false);
    expect(actions.canResolve).toBe(false);
    expect(actions.canResumeAi).toBe(false);
    expect(actions.canTakeOver).toBe(false);
  });

  it('offers reply, release, and resolve on a handoff owned by the current operator', () => {
    const actions = operatorActions(
      activeHandoffRow('a', 'normal', 5, {
        handoff_assigned_name: 'Avery Operator',
        handoff_assigned_to_me: true,
        handoff_is_assigned: true,
        handoff_status: 'acknowledged',
      }),
      MEMBER,
    );

    expect(actions).toEqual({
      canClaim: false,
      canReply: true,
      canRelease: true,
      canResolve: true,
      canResumeAi: false,
      canTakeOver: false,
      ownedByOther: false,
    });
  });

  it('renders a read-only ownership state when a teammate owns the handoff', () => {
    const actions = operatorActions(
      activeHandoffRow('a', 'normal', 5, {
        handoff_assigned_name: 'Blake Operator',
        handoff_assigned_to_me: false,
        handoff_is_assigned: true,
        handoff_status: 'acknowledged',
      }),
      MEMBER,
    );

    expect(actions.ownedByOther).toBe(true);
    expect(actions.canClaim).toBe(false);
    expect(actions.canReply).toBe(false);
    expect(actions.canRelease).toBe(false);
    expect(actions.canResolve).toBe(false);
  });

  it('offers Resume AI only after the escalation is resolved', () => {
    const active = operatorActions(
      activeHandoffRow('a', 'normal', null, {
        handoff_assigned_to_me: true,
        handoff_is_assigned: true,
      }),
      MEMBER,
    );
    const resolved = operatorActions(
      queueRow({
        ai_mode: 'human',
        conversation_assigned_to_me: true,
        conversation_is_assigned: true,
        handoff_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        handoff_is_active: false,
        handoff_status: 'resolved',
      }),
      MEMBER,
    );

    expect(active.canResumeAi).toBe(false);
    expect(resolved.canResumeAi).toBe(true);
    expect(resolved.canReply).toBe(true);
  });

  it('offers Take over only while automation still owns the conversation', () => {
    expect(operatorActions(queueRow(), MEMBER).canTakeOver).toBe(true);
    expect(operatorActions(queueRow({ ai_mode: 'human' }), MEMBER).canTakeOver).toBe(false);
  });

  it('does not offer a text reply on a voice conversation', () => {
    const actions = operatorActions(
      activeHandoffRow('a', 'urgent', null, {
        channel_type: 'phone',
        handoff_assigned_to_me: true,
        handoff_call_status: 'in_progress',
        handoff_is_assigned: true,
        handoff_source: 'voice',
      }),
      MEMBER,
    );

    expect(actions.canReply).toBe(false);
    expect(actions.canResolve).toBe(true);
  });

  it('keeps a conversation owned by a teammate read-only without an active handoff', () => {
    const actions = operatorActions(
      queueRow({
        ai_mode: 'human',
        conversation_assigned_name: 'Blake Operator',
        conversation_is_assigned: true,
      }),
      MEMBER,
    );

    expect(actions).toEqual({
      canClaim: false,
      canReply: false,
      canRelease: false,
      canResolve: false,
      canResumeAi: false,
      canTakeOver: false,
      ownedByOther: true,
    });
  });
});

describe('owner and admin ownership recovery', () => {
  const teammateHandoff = activeHandoffRow('a0000000-0000-4000-8000-000000000000', 'normal', 5, {
    handoff_assigned_name: 'Blake Operator',
    handoff_assigned_to_me: false,
    handoff_is_assigned: true,
    handoff_status: 'acknowledged',
  });
  const teammateConversation = queueRow({
    ai_mode: 'human',
    conversation_assigned_name: 'Blake Operator',
    conversation_is_assigned: true,
  });

  it('maps membership role to the recovery capability', () => {
    expect(operatorViewerFromRole('owner').canOverrideOwnership).toBe(true);
    expect(operatorViewerFromRole('admin').canOverrideOwnership).toBe(true);
    expect(operatorViewerFromRole('member').canOverrideOwnership).toBe(false);
  });

  it('keeps a teammate handoff read-only for a normal member', () => {
    const actions = operatorActions(teammateHandoff, MEMBER);

    expect(actions.canRelease).toBe(false);
    expect(actions.canResolve).toBe(false);
    expect(actions.canReply).toBe(false);
    expect(actions.canClaim).toBe(false);
    expect(actions.ownedByOther).toBe(true);
  });

  it('offers release and resolve on a teammate handoff to an owner or admin', () => {
    const actions = operatorActions(teammateHandoff, ADMIN);

    expect(actions.canRelease).toBe(true);
    expect(actions.canResolve).toBe(true);
    expect(actions.ownedByOther).toBe(true);
  });

  it('never lets an owner or admin reply over or claim on top of the current owner', () => {
    const actions = operatorActions(teammateHandoff, ADMIN);

    expect(actions.canReply).toBe(false);
    expect(actions.canClaim).toBe(false);
    expect(actions.canTakeOver).toBe(false);
  });

  it('withholds Resume AI on a teammate conversation from a normal member', () => {
    const actions = operatorActions(teammateConversation, MEMBER);

    expect(actions.canResumeAi).toBe(false);
    expect(actions.canReply).toBe(false);
    expect(actions.ownedByOther).toBe(true);
  });

  it('offers Resume AI on a teammate conversation to an owner or admin', () => {
    const actions = operatorActions(teammateConversation, ADMIN);

    expect(actions.canResumeAi).toBe(true);
    expect(actions.canReply).toBe(false);
    expect(actions.ownedByOther).toBe(true);
  });
});

describe('safe assignee presentation', () => {
  it('names the current operator without exposing an account identity', () => {
    expect(assigneeLabel(true, 'Avery Operator')).toBe('Assigned to you');
    expect(assigneeLabel(false, 'Avery Operator')).toBe('Assigned to Avery Operator');
    expect(assigneeLabel(false, null)).toBeNull();
  });

  it('explains every ownership conflict the RPCs can return', () => {
    for (const outcome of [
      'already_claimed',
      'already_resolved',
      'not_active',
      'owned_by_other',
      'resolve_handoff_first',
    ]) {
      expect(QUEUE_ACTION_MESSAGES[outcome]).toBeTruthy();
    }
  });
});
