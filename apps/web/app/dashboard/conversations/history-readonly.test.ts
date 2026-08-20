import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Conversation history is read-only.
 *
 * The Inbox owns claim, release, resolve, resume, take over, and reply. A second copy of any of
 * those here would be a second ownership workflow with its own drift, so these assertions read the
 * shipped pages and check that none of them exists.
 */
const HISTORY_PAGES = [
  'apps/web/app/dashboard/conversations/page.tsx',
  'apps/web/app/dashboard/conversations/[id]/page.tsx',
  'apps/web/app/dashboard/customers/page.tsx',
  'apps/web/app/dashboard/customers/[id]/page.tsx',
];

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('history pages carry no operational controls', () => {
  it('defines no ownership or reply action', () => {
    for (const page of HISTORY_PAGES) {
      const text = source(page);
      for (const action of [
        'claimHandoff',
        'releaseHandoff',
        'resolveHandoff',
        'resumeAi',
        'takeOver',
        'sendHumanReply',
        'claim_my_handoff',
        'release_my_handoff',
        'resolve_my_handoff',
      ]) {
        expect(text).not.toContain(action);
      }
    }
  });

  it('submits no form and calls no server action from history', () => {
    for (const page of HISTORY_PAGES) {
      const text = source(page);
      // Customers has a search form, but it lives in its own client component; the pages
      // themselves render no form and no mutation.
      expect(text).not.toContain('<form');
      expect(text).not.toContain("'use server'");
    }
  });

  it('links to the Inbox for live work rather than reimplementing it', () => {
    const detail = source('apps/web/app/dashboard/conversations/[id]/page.tsx');
    expect(detail).toContain('/dashboard/inbox');
    expect(detail).toContain('Open in Inbox');
  });
});

describe('history routes validate external input', () => {
  it('validates the route identifier before reaching the database', () => {
    for (const page of [
      'apps/web/app/dashboard/customers/[id]/page.tsx',
      'apps/web/app/dashboard/conversations/[id]/page.tsx',
    ]) {
      const text = source(page);
      // A malformed identifier becomes the same Unavailable state as a foreign one.
      expect(text).toContain('safeUuid(');
      expect(text).toContain('<Unavailable />');
    }
  });

  it('validates every cursor before paging', () => {
    expect(source('apps/web/app/dashboard/customers/page.tsx')).toContain('safePageCursor(');
    expect(source('apps/web/app/dashboard/conversations/page.tsx')).toContain('safePageCursor(');
    expect(source('apps/web/app/dashboard/conversations/[id]/page.tsx')).toContain(
      'safePageCursor(',
    );
    expect(source('apps/web/app/dashboard/customers/[id]/page.tsx')).toContain(
      'safeTimelineCursor(',
    );
  });
});
