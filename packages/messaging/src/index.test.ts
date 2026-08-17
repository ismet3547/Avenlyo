import { describe, expect, it } from 'vitest';

import {
  detectSmsKeywordCommand,
  normalizeE164,
  canTransitionTwilioDeliveryState,
  normalizedTwilioDeliveryState,
  twilioWebhookUrl,
} from './index';

describe('messaging primitives', () => {
  it('accepts canonical E.164 values only', () => {
    expect(normalizeE164('+14155552671')).toBe('+14155552671');
    expect(normalizeE164('14155552671')).toBeNull();
    expect(normalizeE164('+0123')).toBeNull();
  });

  it('detects deterministic provider keyword fallbacks', () => {
    expect(detectSmsKeywordCommand(' STOP ')).toBe('stop');
    expect(detectSmsKeywordCommand('start')).toBe('start');
    expect(detectSmsKeywordCommand('Help')).toBe('help');
    expect(detectSmsKeywordCommand('please stop')).toBeNull();
  });

  it('uses an explicit delivery transition graph instead of rank ordering', () => {
    expect(normalizedTwilioDeliveryState('accepted')).toBe('submitted');
    expect(canTransitionTwilioDeliveryState('queued', 'failed')).toBe(true);
    expect(canTransitionTwilioDeliveryState('sent', 'delivered')).toBe(true);
    expect(canTransitionTwilioDeliveryState('sent', 'failed')).toBe(false);
    expect(canTransitionTwilioDeliveryState('delivered', 'failed')).toBe(false);
    expect(canTransitionTwilioDeliveryState('failed', 'sent')).toBe(false);
  });

  it('uses the configured canonical webhook base', () => {
    expect(
      twilioWebhookUrl('https://api.avenlyo.test/v1', '/webhooks/twilio/messaging/inbound'),
    ).toBe('https://api.avenlyo.test/v1/webhooks/twilio/messaging/inbound');
  });
});
