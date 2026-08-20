import { redirect } from 'next/navigation';

/**
 * Needs Attention already exists.
 *
 * Phase 13 built it inside the Inbox, where ownership and the attention queue share one state
 * machine. A second queue here would be a duplicate of that machine with its own drift, so this
 * route sends the operator to the one that is real.
 */
export default function NeedsAttentionPage() {
  redirect('/dashboard/inbox');
}
