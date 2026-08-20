import { readFileSync } from 'node:fs';

import type { CustomerDirectoryRow } from '@avenlyo/database';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./actions', () => ({ searchCustomersAction: vi.fn() }));

const { CustomerDirectory } = await import('./customer-directory');

/**
 * The directory component and its boundary with the page.
 *
 * A plain function is not a serializable Server Component prop, so passing a date formatter across
 * would fail at runtime however green the build looks. These assertions read the shipped page and
 * render the shipped component rather than trusting that.
 */

const SECRET_PHONE = '+15551234567';
const SECRET_EMAIL = 'customer-secret@example.test';

function customer(overrides: Partial<CustomerDirectoryRow> = {}): CustomerDirectoryRow {
  return {
    appointment_count: 1,
    call_count: 2,
    contact_id: '11111111-1111-4111-8111-111111111111',
    conversation_count: 3,
    display_name: 'Robin Shared',
    email: null,
    first_activity_at: '2026-08-01T00:00:00.000Z',
    first_name: 'Robin',
    last_activity_at: '2026-08-19T00:00:00.000Z',
    last_name: 'Shared',
    lead_status: null,
    phone: null,
    sms_opted_out: false,
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof CustomerDirectory>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(CustomerDirectory, {
      customers: [customer()],
      locationName: 'Location A',
      nextCursor: null,
      ...props,
    }),
  );
}

function pageSource(): string {
  return readFileSync('apps/web/app/dashboard/customers/page.tsx', 'utf8');
}

describe('G. the server to client boundary carries only data', () => {
  it('passes no function-valued prop to the client component', () => {
    const source = pageSource();
    // A formatter would be the obvious one, and it is exactly what fails to serialize.
    expect(source).not.toContain('formatDate={');
    expect(source).not.toMatch(/<CustomerDirectory[\s\S]*?=\{\s*function/);
    expect(source).not.toMatch(/<CustomerDirectory[\s\S]*?=\{\s*\(\s*\w*\s*\)\s*=>/);
    // And the page no longer declares a formatter of its own to pass.
    expect(source).not.toContain('function formatDate');
  });

  it('passes the customer rows, location name, and cursor as plain values', () => {
    const source = pageSource();
    expect(source).toContain('customers={page.customers}');
    expect(source).toContain('locationName={locationName}');
    expect(source).toContain('nextCursor={');
  });

  it('formats activity dates locally, without a round trip', () => {
    // The shared helper is imported by the client component itself.
    const component = readFileSync(
      'apps/web/app/dashboard/customers/customer-directory.tsx',
      'utf8',
    );
    expect(component).toContain("from '@/lib/customers/presentation'");
    expect(component).toContain('formatActivityDate');
    expect(component).not.toContain("'use server'");
    // And it actually renders a formatted date.
    expect(render()).toContain('Aug 19, 2026');
  });
});

describe('A. the unsearched directory is what renders first', () => {
  it('shows the directory and not the search result view', () => {
    const html = render();
    expect(html).toContain('data-testid="customer-directory"');
    expect(html).not.toContain('data-testid="customer-search-results"');
    expect(html).toContain('Robin Shared');
  });

  it('shows the empty state naming the location when there is nobody yet', () => {
    const html = render({ customers: [] });
    expect(html).toContain('No customers have interacted with Location A yet.');
  });

  it('keeps a linkable cursor for the unsearched directory', () => {
    const html = render({
      nextCursor: {
        identifier: '11111111-1111-4111-8111-111111111111',
        timestamp: '2026-08-19T00:00:00.000Z',
      },
    });
    // A timestamp and a UUID are not customer content, so paging this in the URL is safe.
    expect(html).toContain('after=2026-08-19');
    expect(html).toContain('Show older customers');
  });
});

describe('the search form carries no URL contract', () => {
  it('renders a search form with no action and no query link', () => {
    const html = render();
    expect(html).toContain('role="search"');
    expect(html).toContain('name="term"');
    expect(html).not.toContain('name="q"');
    expect(html).not.toContain('/dashboard/customers?q=');
  });

  it('renders customer links that contain only the contact identifier', () => {
    const html = render({
      customers: [customer({ email: SECRET_EMAIL, phone: SECRET_PHONE })],
    });
    // The phone and email are shown in the card, which is the point of the page, but the only
    // navigable value is the UUID.
    expect(html).toContain('href="/dashboard/customers/11111111-1111-4111-8111-111111111111"');
    expect(html).not.toContain(`href="/dashboard/customers/${SECRET_PHONE}`);
    expect(html).not.toContain(encodeURIComponent(SECRET_EMAIL));
  });
});

describe('the conversation archive contract stays closed', () => {
  it('accepts no search parameter', () => {
    const source = readFileSync('apps/web/app/dashboard/conversations/page.tsx', 'utf8');
    expect(source).not.toContain('params.q');
    expect(source).not.toContain('q?: string');
  });
});
