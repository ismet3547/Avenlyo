import { describe, expect, it, vi } from 'vitest';

import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

import {
  CUSTOMER_PAGE_SIZE,
  TRANSCRIPT_PAGE_SIZE,
  loadConversationArchive,
  loadConversationDetail,
  loadConversationTranscript,
  loadCustomerDirectory,
  loadCustomerOverview,
} from './service';

/**
 * Customer history data access.
 *
 * Two properties matter. Every view is one bounded RPC, so the browser never assembles history from
 * several tables. And an unavailable record produces an empty result rather than an error that
 * would reveal whether the identifier names something real.
 */

const LOCATION = '33333333-3333-4333-8333-333333333331';
const CONTACT = '66666666-6666-4666-8666-666666666661';
const CONVERSATION = '77777777-7777-4777-8777-777777777771';

function clientReturning(rows: unknown[]) {
  const rpc = vi.fn(() => Promise.resolve({ data: rows, error: null }));
  return { client: { rpc } as unknown as AvenlyoSupabaseClient, rpc };
}

function directoryRow(overrides: Record<string, unknown> = {}) {
  return {
    contact_id: CONTACT,
    display_name: 'Robin Shared',
    first_name: 'Robin',
    last_name: 'Shared',
    phone: '+15405550101',
    email: null,
    first_activity_at: '2026-08-01T00:00:00.000Z',
    last_activity_at: '2026-08-19T00:00:00.000Z',
    conversation_count: 2,
    call_count: 1,
    appointment_count: 1,
    lead_status: 'qualified',
    sms_opted_out: false,
    ...overrides,
  };
}

function transcriptRow(overrides: Record<string, unknown> = {}) {
  return {
    message_id: '88888888-8888-4888-8888-888888888881',
    author_type: 'customer',
    direction: 'inbound',
    source_channel: 'sms',
    message_type: 'text',
    body: 'Are you open on Saturday?',
    created_at: '2026-08-19T10:00:00.000Z',
    sent_at: null,
    author_display_name: null,
    in_reply_to_message_id: null,
    delivery_status: null,
    delivery_updated_at: null,
    ...overrides,
  };
}

describe('customer directory', () => {
  it('loads a page in a single bounded request', async () => {
    const { client, rpc } = clientReturning([directoryRow()]);

    const page = await loadCustomerDirectory(client, { locationId: LOCATION });

    // One call for the whole page: no query per customer and none per activity family.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_my_customer_directory', {
      cursor_contact_id: null,
      cursor_last_activity_at: null,
      page_limit: CUSTOMER_PAGE_SIZE,
      target_location_id: LOCATION,
      target_search: null,
    });
    expect(page.customers).toHaveLength(1);
  });

  it('offers no next page when the page is short', async () => {
    const { client } = clientReturning([directoryRow()]);
    const page = await loadCustomerDirectory(client, { locationId: LOCATION });
    // A dead "show more" control is worse than none.
    expect(page.nextCursor).toBeNull();
  });

  it('produces a keyset cursor from the last row of a full page', async () => {
    const rows = Array.from({ length: CUSTOMER_PAGE_SIZE }, (_unused, index) =>
      directoryRow({
        contact_id: `66666666-6666-4666-8666-6666666666${String(index).padStart(2, '0')}`,
        last_activity_at: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    const { client } = clientReturning(rows);

    const page = await loadCustomerDirectory(client, { locationId: LOCATION });

    expect(page.nextCursor).toEqual({
      contactId: rows[CUSTOMER_PAGE_SIZE - 1]?.contact_id,
      lastActivityAt: rows[CUSTOMER_PAGE_SIZE - 1]?.last_activity_at,
    });
  });

  it('drops a search term that is too short to be meaningful', async () => {
    const { client, rpc } = clientReturning([]);
    await loadCustomerDirectory(client, { locationId: LOCATION, search: '  ' });
    expect(rpc).toHaveBeenCalledWith(
      'get_my_customer_directory',
      expect.objectContaining({ target_search: null }),
    );
  });
});

describe('unavailable records', () => {
  it('returns null for a customer that is not visible here', async () => {
    // The database returns no row for a guessed identifier, a foreign customer, and one with no
    // local activity alike. The client cannot tell them apart either.
    const { client } = clientReturning([]);
    await expect(
      loadCustomerOverview(client, { contactId: CONTACT, locationId: LOCATION }),
    ).resolves.toBeNull();
  });

  it('returns null for a conversation that is not visible here', async () => {
    const { client } = clientReturning([]);
    await expect(
      loadConversationDetail(client, { conversationId: CONVERSATION, locationId: LOCATION }),
    ).resolves.toBeNull();
  });
});

describe('conversation archive', () => {
  it('forwards only the filters it was given', async () => {
    const { client, rpc } = clientReturning([]);

    await loadConversationArchive(client, {
      channel: 'sms',
      locationId: LOCATION,
      status: 'closed',
    });

    expect(rpc).toHaveBeenCalledWith('get_my_conversation_archive', {
      cursor_activity_at: null,
      cursor_conversation_id: null,
      page_limit: CUSTOMER_PAGE_SIZE,
      target_channel: 'sms',
      target_location_id: LOCATION,
      target_search: null,
      target_status: 'closed',
    });
  });
});

describe('transcript window', () => {
  it('reverses the newest-first query so a page reads oldest to newest', async () => {
    const newestFirst = [
      transcriptRow({
        created_at: '2026-08-19T12:00:00.000Z',
        message_id: '88888888-8888-4888-8888-888888888883',
      }),
      transcriptRow({
        created_at: '2026-08-19T11:00:00.000Z',
        message_id: '88888888-8888-4888-8888-888888888882',
      }),
      transcriptRow({
        created_at: '2026-08-19T10:00:00.000Z',
        message_id: '88888888-8888-4888-8888-888888888881',
      }),
    ];
    const { client } = clientReturning(newestFirst);

    const page = await loadConversationTranscript(client, {
      conversationId: CONVERSATION,
      locationId: LOCATION,
    });

    expect(page.messages.map((message) => message.created_at)).toEqual([
      '2026-08-19T10:00:00.000Z',
      '2026-08-19T11:00:00.000Z',
      '2026-08-19T12:00:00.000Z',
    ]);
  });

  it('offers an older cursor only when the window was full', async () => {
    const { client } = clientReturning([transcriptRow()]);
    const shortPage = await loadConversationTranscript(client, {
      conversationId: CONVERSATION,
      locationId: LOCATION,
    });
    expect(shortPage.olderCursor).toBeNull();

    const full = Array.from({ length: TRANSCRIPT_PAGE_SIZE }, (_unused, index) =>
      transcriptRow({
        created_at: `2026-08-19T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
        message_id: `88888888-8888-4888-8888-8888888888${String(index).padStart(2, '0')}`,
      }),
    );
    const { client: fullClient } = clientReturning(full);
    const fullPage = await loadConversationTranscript(fullClient, {
      conversationId: CONVERSATION,
      locationId: LOCATION,
    });
    // The cursor names the oldest row of the window, which is where the next page continues.
    expect(fullPage.olderCursor).toEqual({
      createdAt: full[TRANSCRIPT_PAGE_SIZE - 1]?.created_at,
      messageId: full[TRANSCRIPT_PAGE_SIZE - 1]?.message_id,
    });
  });

  it('never surfaces a provider identifier even if one were returned', async () => {
    const { client } = clientReturning([
      transcriptRow({ external_id: 'SM_provider_secret', metadata: { provider: 'twilio' } }),
    ]);

    const page = await loadConversationTranscript(client, {
      conversationId: CONVERSATION,
      locationId: LOCATION,
    });

    // The parsed shape has nowhere to put them, so they cannot reach a page.
    const serialized = JSON.stringify(page.messages);
    expect(serialized).not.toContain('SM_provider_secret');
    expect(serialized).not.toContain('metadata');
    expect(serialized).not.toContain('external_id');
  });
});
