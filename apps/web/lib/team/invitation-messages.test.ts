import { describe, expect, it } from 'vitest';

import { invitationMessage, type InvitationOutcome } from './invitation-messages';

const OUTCOMES: readonly InvitationOutcome[] = [
  'accepted',
  'already_accepted',
  'already_member',
  'expired',
  'invalid',
  'invalid_scope',
  'revoked',
  'verified_email_required',
  'wrong_account',
];

/**
 * Whoever opens an invitation link is not yet known to be the person invited, so every message has
 * to be safe to show a stranger.
 */
describe('invitation messages', () => {
  it('has a stable message for every outcome', () => {
    for (const outcome of OUTCOMES) {
      const message = invitationMessage(outcome);
      expect(message.title.length).toBeGreaterThan(0);
      expect(message.body.length).toBeGreaterThan(0);
    }
  });

  it('treats every outcome that means "you have access" as success', () => {
    // already_member is a success: the person has access, and presenting an invitation must never
    // change the role or locations they already hold.
    for (const outcome of ['accepted', 'already_accepted', 'already_member'] as const) {
      expect(invitationMessage(outcome).tone).toBe('success');
    }
    for (const outcome of [
      'expired',
      'invalid',
      'invalid_scope',
      'revoked',
      'verified_email_required',
      'wrong_account',
    ] as const) {
      expect(invitationMessage(outcome).tone).toBe('error');
    }
  });

  it('tells an unconfirmed account what to do without naming the invitation', () => {
    const message = invitationMessage('verified_email_required');
    expect(message.body).toContain('Confirm your email');
    // Still says nothing about who was invited or which workspace is involved.
    expect(`${message.title} ${message.body}`).not.toMatch(/@/);
  });

  it('never reveals who was invited or which workspace is involved', () => {
    const wrongAccount = invitationMessage('wrong_account');
    expect(`${wrongAccount.title} ${wrongAccount.body}`).not.toMatch(/@/);
    for (const outcome of OUTCOMES) {
      const message = invitationMessage(outcome);
      const text = `${message.title} ${message.body}`.toLowerCase();
      // No database, constraint, or function detail reaches a bearer-token holder.
      for (const forbidden of [
        'sql',
        'constraint',
        'postgres',
        'supabase',
        'token',
        'null',
        'rpc',
      ]) {
        expect(text).not.toContain(forbidden);
      }
    }
  });

  it('gives an expired and a revoked invitation distinct, actionable wording', () => {
    expect(invitationMessage('expired').body).toContain('new one');
    expect(invitationMessage('revoked').body).toContain('withdrawn');
  });

  it('does not distinguish an unknown token from a malformed one', () => {
    // Distinguishing them would confirm that a given link once existed.
    expect(invitationMessage('invalid').title).toBe(invitationMessage('invalid_scope').title);
  });
});
