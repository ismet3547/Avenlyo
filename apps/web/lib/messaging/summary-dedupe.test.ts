import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Proves the Inbox summary is fetched once per request and shared, not fetched separately by the
 * dashboard layout's badge and the Inbox page's tiles. `cache()` itself cannot be asserted on in a
 * plain Vitest run -- it only memoizes inside an active Server Component render -- so this checks
 * the two things that are true regardless of render context: the RPC name appears in exactly one
 * place in source, and both call sites route through that one memoized function.
 */

function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .split('\r\n')
    .join('\n');
}

const service = readSource('./service.ts');
const dashboardLayout = readSource('../../app/dashboard/layout.tsx');
const inboxPage = readSource('../../app/dashboard/inbox/page.tsx');

describe('the handoff queue summary RPC is called from exactly one place', () => {
  it('is issued only inside lib/messaging/service.ts', () => {
    expect(service).toContain("'get_my_handoff_queue_summary'");
    expect(dashboardLayout).not.toContain('get_my_handoff_queue_summary');
    expect(inboxPage).not.toContain('get_my_handoff_queue_summary');
  });

  it('is memoized per request', () => {
    expect(service).toContain('cache(resolveHandoffQueueSummary)');
  });

  it('the dashboard layout badge reads the shared loader', () => {
    expect(dashboardLayout).toContain('loadHandoffQueueSummary(auth.supabase, context.locationId)');
  });

  it('the Inbox page tiles read the same shared loader, not a second RPC call', () => {
    expect(inboxPage).toContain('loadHandoffQueueSummary(auth.supabase, workspace.locationId)');
  });
});
