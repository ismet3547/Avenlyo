import { BookingProviderError, providerErrorForStatus } from '../scheduling/errors';
import { PROVIDER_REQUEST_TIMEOUT_MS, SAFE_GET_MAX_ATTEMPTS } from '../scheduling/limits';

import type { GoogleBusyPeriod, GoogleCalendarListEntry, GoogleCalendarTransport, GoogleEvent } from './types';

const API_ORIGIN = 'https://www.googleapis.com/calendar/v3';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BookingProviderError('provider_error');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function bool(value: unknown): boolean { return value === true; }

export class FetchGoogleCalendarTransport implements GoogleCalendarTransport {
  public async request(input: {
    readonly body?: Readonly<Record<string, unknown>>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method: 'GET' | 'POST';
    readonly timeoutMs: number;
    readonly url: string;
  }): Promise<{ readonly body: unknown; readonly status: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetch(input.url, {
        method: input.method,
        signal: controller.signal,
        headers: { ...(input.body ? { 'Content-Type': 'application/json' } : {}), ...input.headers },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      });
      const bodyText = await response.text();
      let body: unknown = null;
      if (bodyText) {
        try { body = JSON.parse(bodyText) as unknown; } catch { throw new BookingProviderError('provider_error'); }
      }
      return { body, status: response.status };
    } catch (error) {
      if (error instanceof BookingProviderError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') throw new BookingProviderError('timeout');
      throw new BookingProviderError('network');
    } finally { clearTimeout(timer); }
  }
}

/** Calendar API wrapper: safe reads retry; event inserts intentionally never blindly retry. */
export class GoogleCalendarClient {
  public constructor(private readonly input: {
    readonly accessToken: () => Promise<string>;
    readonly transport: GoogleCalendarTransport;
    readonly wait?: (milliseconds: number) => Promise<void>;
  }) {}

  public async calendarList(pageToken?: string): Promise<{ readonly items: readonly GoogleCalendarListEntry[]; readonly nextPageToken: string | null }> {
    const url = new URL(`${API_ORIGIN}/users/me/calendarList`);
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = record(await this.request('GET', url.toString(), undefined, true));
    const values = Array.isArray(body.items) ? body.items : [];
    return {
      items: values.flatMap((item) => {
        const value = record(item);
        const id = text(value.id); const summary = text(value.summary); const accessRole = text(value.accessRole);
        if (!id || !summary || !['freeBusyReader', 'reader', 'writer', 'owner'].includes(accessRole ?? '')) return [];
        return [{ id, summary, accessRole: accessRole as GoogleCalendarListEntry['accessRole'], primary: bool(value.primary), timeZone: text(value.timeZone) }];
      }),
      nextPageToken: text(body.nextPageToken),
    };
  }

  public async freeBusy(input: { readonly calendarIds: readonly string[]; readonly timeMax: string; readonly timeMin: string; readonly timeZone: string }): Promise<ReadonlyMap<string, readonly GoogleBusyPeriod[]>> {
    const body = record(await this.request('POST', `${API_ORIGIN}/freeBusy`, {
      items: input.calendarIds.map((id) => ({ id })), timeMin: input.timeMin, timeMax: input.timeMax, timeZone: input.timeZone,
    }, true));
    const calendars = record(body.calendars);
    const result = new Map<string, readonly GoogleBusyPeriod[]>();
    for (const id of input.calendarIds) {
      const entry = calendars[id];
      if (!entry) { result.set(id, []); continue; }
      const busyValue = record(entry).busy;
      const busy: readonly unknown[] = Array.isArray(busyValue) ? busyValue : [];
      result.set(id, busy.flatMap((range: unknown) => {
        const raw = record(range); const start = text(raw.start); const end = text(raw.end);
        return start && end && Date.parse(end) > Date.parse(start) ? [{ start, end }] : [];
      }));
    }
    return result;
  }

  public async insertEvent(calendarId: string, event: Readonly<Record<string, unknown>>): Promise<GoogleEvent> {
    return this.eventFrom(await this.request('POST', `${API_ORIGIN}/calendars/${encodeURIComponent(calendarId)}/events`, event, false));
  }

  public async getEvent(calendarId: string, eventId: string): Promise<GoogleEvent> {
    return this.eventFrom(await this.request('GET', `${API_ORIGIN}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, undefined, true));
  }

  private async request(method: 'GET' | 'POST', url: string, body: Readonly<Record<string, unknown>> | undefined, safeRead: boolean): Promise<unknown> {
    const attempts = safeRead ? SAFE_GET_MAX_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const token = await this.input.accessToken();
      try {
        const result = await this.input.transport.request({
          ...(body ? { body } : {}),
          headers: { Authorization: `Bearer ${token}` },
          method, timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS, url,
        });
        if (result.status >= 200 && result.status < 300) return result.body;
        const error = providerErrorForStatus(result.status, !safeRead);
        if (safeRead && error.retryable && attempt + 1 < attempts) { await this.backoff(attempt); continue; }
        throw error;
      } catch (error) {
        const normalized = error instanceof BookingProviderError ? error : new BookingProviderError('network');
        if (safeRead && normalized.retryable && attempt + 1 < attempts) { await this.backoff(attempt); continue; }
        throw normalized;
      }
    }
    throw new BookingProviderError('provider_error');
  }

  private eventFrom(value: unknown): GoogleEvent {
    const raw = record(value); const id = text(raw.id); const status = text(raw.status);
    const start = text(record(raw.start).dateTime); const end = text(record(raw.end).dateTime);
    const privateProperties = record(record(raw.extendedProperties).private);
    if (!id || !status || !start || !end) throw new BookingProviderError('provider_state_unknown');
    return { id, status, start, end, privateProperties: Object.fromEntries(Object.entries(privateProperties).flatMap(([key, val]) => typeof val === 'string' ? [[key, val]] : [])) };
  }

  private async backoff(attempt: number): Promise<void> {
    const milliseconds = 150 * 2 ** attempt + Math.floor(Math.random() * 100);
    if (this.input.wait) return this.input.wait(milliseconds);
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}
