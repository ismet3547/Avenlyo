/** Shared provider-neutral messaging primitives. They intentionally contain no credentials or IO. */
export type SmsKeywordCommand = 'help' | 'start' | 'stop' | null;

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);

export function normalizeE164(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return /^\+[1-9][0-9]{7,14}$/.test(normalized) ? normalized : null;
}

export function detectSmsKeywordCommand(value: string | null | undefined): SmsKeywordCommand {
  const normalized = value?.trim().replace(/\s+/g, ' ').toLowerCase() ?? '';
  if (STOP_WORDS.has(normalized)) return 'stop';
  if (START_WORDS.has(normalized)) return 'start';
  return normalized === 'help' ? 'help' : null;
}

/** A monotonic provider-state ordering prevents an older callback from downgrading delivery UI. */
export function twilioDeliveryRank(status: string): number | null {
  switch (status) {
    case 'queued':
      return 0;
    case 'sending':
      return 1;
    case 'sent':
      return 2;
    case 'delivered':
      return 3;
    case 'failed':
      return 4;
    case 'undelivered':
      return 5;
    default:
      return null;
  }
}

export function isTwilioMessageSid(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^SM[a-zA-Z0-9]{32}$/.test(value);
}

export function twilioWebhookUrl(baseUrl: string, route: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error('Twilio webhook base URL must be HTTP(S).');
  }
  if (!route.startsWith('/')) throw new Error('Twilio webhook route must start with /.');
  const basePath = base.pathname.replace(/\/$/, '');
  return new URL(`${basePath}${route}`, base.origin).toString();
}
