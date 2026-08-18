export type GoogleAccessRole = 'freeBusyReader' | 'reader' | 'writer' | 'owner';

export interface GoogleCalendarListEntry {
  readonly accessRole: GoogleAccessRole;
  readonly id: string;
  readonly primary: boolean;
  readonly summary: string;
  readonly timeZone: string | null;
}

export interface GoogleBusyPeriod {
  readonly end: string;
  readonly start: string;
}

export interface GoogleEvent {
  readonly end: string;
  readonly etag: string;
  readonly id: string;
  readonly privateProperties: Readonly<Record<string, string>>;
  /** Complete event resource retained for Events.update full-resource semantics. */
  readonly resource: Readonly<Record<string, unknown>>;
  readonly start: string;
  readonly status: string;
}

export interface GoogleCalendarTransport {
  request(input: {
    readonly body?: Readonly<Record<string, unknown>>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method: 'DELETE' | 'GET' | 'POST' | 'PUT';
    readonly timeoutMs: number;
    readonly url: string;
  }): Promise<{ readonly body: unknown; readonly status: number }>;
}
