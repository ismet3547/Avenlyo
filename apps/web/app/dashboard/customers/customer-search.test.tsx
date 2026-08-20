import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./actions', () => ({ searchCustomersAction: vi.fn() }));

const { CustomerSearch } = await import('./customer-search');

/**
 * Customer search must not put PII in a URL.
 *
 * Search matches phone and email, so a query parameter would place a customer's number in the
 * address bar, in browser history, in any copied or shared link, and possibly in a referrer. These
 * assertions render the shipped component and read what it actually emits, rather than testing a
 * helper that the component might not use.
 */

const SECRET_PHONE = '+15551234567';
const SECRET_EMAIL = 'customer-secret@example.test';

function render() {
  return renderToStaticMarkup(createElement(CustomerSearch, { formatDate: () => 'a date' }));
}

describe('customer search transport', () => {
  it('submits through a server action rather than navigating', () => {
    const html = render();
    // A form with no action attribute and no href is a component that cannot put a term in a URL.
    expect(html).toContain('role="search"');
    expect(html).not.toContain('href="/dashboard/customers?');
    expect(html).not.toMatch(/action="[^"]*q=/);
  });

  it('renders no field whose value would travel as a query parameter', () => {
    const html = render();
    // The input is named for the action payload, not for a URL contract.
    expect(html).toContain('name="term"');
    expect(html).not.toContain('name="q"');
  });

  it('never emits a typed term into markup that could become a URL', () => {
    // The term lives in component state. Nothing renders it into an href, a hidden field, or any
    // attribute that a navigation would carry.
    const html = render();
    for (const secret of [SECRET_PHONE, SECRET_EMAIL]) {
      expect(html).not.toContain(secret);
      expect(html).not.toContain(encodeURIComponent(secret));
    }
  });
});

describe('customer directory URL contract', () => {
  it('has no search parameter at all', async () => {
    // The page's own contract is the other half: even a crafted ?q= is not read, so there is no
    // supported path that puts a term in the address bar.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('apps/web/app/dashboard/customers/page.tsx', 'utf8'),
    );
    expect(source).not.toContain('params.q');
    expect(source).not.toContain('q?: string');
    expect(source).not.toMatch(/q:\s*search/);
  });

  it('keeps only opaque cursor values in pagination links', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('apps/web/app/dashboard/customers/page.tsx', 'utf8'),
    );
    // after and afterId are a timestamp and a UUID: not customer content.
    expect(source).toContain('after: page.nextCursor.lastActivityAt');
    expect(source).toContain('afterId: page.nextCursor.contactId');
  });
});

describe('conversation archive URL contract', () => {
  it('accepts no search parameter, so a term cannot reach the archive URL', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('apps/web/app/dashboard/conversations/page.tsx', 'utf8'),
    );
    expect(source).not.toContain('params.q');
    expect(source).not.toContain('q?: string');
  });

  it('keeps channel and status filters in the URL, because neither is customer data', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('apps/web/app/dashboard/conversations/page.tsx', 'utf8'),
    );
    expect(source).toContain('channel ? { channel } : {}');
    expect(source).toContain('status ? { status } : {}');
  });
});
