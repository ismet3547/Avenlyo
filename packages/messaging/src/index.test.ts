import { describe, expect, it } from 'vitest';

import {
  detectSmsKeywordCommand,
  normalizeE164,
  twilioDeliveryRank,
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

  it('keeps status callback ordering monotonic', () => {
    expect(twilioDeliveryRank('queued')).toBeLessThan(twilioDeliveryRank('delivered') ?? 0);
    expect(twilioDeliveryRank('bad')).toBeNull();
  });

  it('uses the configured canonical webhook base', () => {
    expect(
      twilioWebhookUrl('https://api.avenlyo.test/v1', '/webhooks/twilio/messaging/inbound'),
    ).toBe('https://api.avenlyo.test/v1/webhooks/twilio/messaging/inbound');
  });
});
