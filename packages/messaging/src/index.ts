/** Shared provider-neutral messaging primitives. They intentionally contain no credentials or IO. */
export type SmsKeywordCommand = 'help' | 'start' | 'stop' | null;

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_WORDS = new Set(['start', 'unstop']);

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

export type TwilioDeliveryState =
  | 'queued'
  | 'submitting'
  | 'submitted'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'undelivered'
  | 'unknown'
  | 'suppressed';

export function normalizedTwilioDeliveryState(
  status: string,
): 'submitted' | 'sent' | 'delivered' | 'failed' | 'undelivered' | null {
  switch (status.trim().toLowerCase()) {
    case 'queued':
    case 'accepted':
    case 'sending':
      return 'submitted';
    case 'sent':
    case 'delivered':
    case 'failed':
    case 'undelivered':
      return status.trim().toLowerCase() as 'sent' | 'delivered' | 'failed' | 'undelivered';
    default:
      return null;
  }
}

export function canTransitionTwilioDeliveryState(
  current: TwilioDeliveryState,
  next: TwilioDeliveryState,
): boolean {
  if (current === next) return true;
  if (current === 'queued')
    return [
      'submitting',
      'submitted',
      'sent',
      'delivered',
      'failed',
      'undelivered',
      'suppressed',
    ].includes(next);
  if (current === 'submitting')
    return ['submitted', 'sent', 'delivered', 'failed', 'undelivered', 'unknown'].includes(next);
  if (current === 'submitted') return ['sent', 'delivered', 'failed', 'undelivered'].includes(next);
  if (current === 'sent') return next === 'delivered' || next === 'undelivered';
  return false;
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
