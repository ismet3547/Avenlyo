import type { InvitationAcceptanceRow } from '@avenlyo/database';

/**
 * Stable, safe presentation for every acceptance outcome.
 *
 * A raw PostgreSQL or Supabase error would leak function names and constraint text to whoever is
 * holding the link, and the person holding it is not necessarily the person invited. Each outcome
 * maps to one fixed sentence that says what to do next without confirming who was invited, whether
 * the address exists, or which organization is involved.
 */

export type InvitationOutcome = InvitationAcceptanceRow['outcome'];

export interface InvitationMessage {
  readonly body: string;
  readonly title: string;
  readonly tone: 'error' | 'success';
}

const MESSAGES: Readonly<Record<InvitationOutcome, InvitationMessage>> = {
  accepted: {
    body: 'You now have access. Continue to your workspace.',
    title: 'Invitation accepted',
    tone: 'success',
  },
  already_accepted: {
    body: 'This invitation was already accepted with this account. Continue to your workspace.',
    title: 'Already accepted',
    tone: 'success',
  },
  // Not a failure: the person already has access, and presenting an invitation must never change
  // the role or locations they already hold.
  already_member: {
    body: 'You already have access to this workspace. Continue to your workspace.',
    title: 'Already a member',
    tone: 'success',
  },
  expired: {
    body: 'This invitation link has expired. Ask the person who invited you to send a new one.',
    title: 'Invitation expired',
    tone: 'error',
  },
  // Deliberately identical wording to a malformed token: distinguishing them would confirm that a
  // given link once existed.
  invalid: {
    body: 'This invitation link is not valid. Ask the person who invited you to send a new one.',
    title: 'Invitation unavailable',
    tone: 'error',
  },
  invalid_scope: {
    body: 'This invitation no longer matches an available location. Ask for a new invitation.',
    title: 'Invitation unavailable',
    tone: 'error',
  },
  revoked: {
    body: 'This invitation was withdrawn. Ask the person who invited you to send a new one.',
    title: 'Invitation withdrawn',
    tone: 'error',
  },
  // The account exists but has not proved it owns the address, so its identity is unproven.
  verified_email_required: {
    body: 'Confirm your email address first, then open this invitation link again.',
    title: 'Email confirmation required',
    tone: 'error',
  },
  // Says nothing about which address was invited.
  wrong_account: {
    body: 'This invitation was issued for a different email address. Sign in with the invited account and open the link again.',
    title: 'Different account required',
    tone: 'error',
  },
};

export function invitationMessage(outcome: InvitationOutcome): InvitationMessage {
  return MESSAGES[outcome];
}
