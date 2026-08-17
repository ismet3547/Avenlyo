import twilio from 'twilio';
import { describe, expect, it } from 'vitest';

import { canonicalTwilioWebhookUrl, validateTwilioSignature } from './twilio.js';

const configuration = {
  accountSid: 'AC00000000000000000000000000000000',
  authToken: '0123456789abcdef0123456789abcdef',
  webhookBaseUrl: 'https://api.avenlyo.example',
};
const route = '/v1/webhooks/twilio/messaging/inbound' as const;
const form = {
  Body: 'Hello',
  From: '+14155550123',
  MessageSid: 'SM00000000000000000000000000000001',
  NumMedia: '0',
  To: '+14155550999',
};

describe('Twilio webhook verification', () => {
  it('accepts the official SDK signature for the exact configured URL and all form fields', () => {
    const signature = twilio.getExpectedTwilioSignature(
      configuration.authToken,
      canonicalTwilioWebhookUrl(configuration, route),
      form,
    );
    expect(validateTwilioSignature({ configuration, form, route, signature })).toBe(true);
  });

  it('rejects a signature when a submitted Twilio form field changes', () => {
    const signature = twilio.getExpectedTwilioSignature(
      configuration.authToken,
      canonicalTwilioWebhookUrl(configuration, route),
      form,
    );
    expect(
      validateTwilioSignature({
        configuration,
        form: { ...form, Body: 'Tampered' },
        route,
        signature,
      }),
    ).toBe(false);
  });

  it('rejects a signature made for a different canonical callback path', () => {
    const signature = twilio.getExpectedTwilioSignature(
      configuration.authToken,
      canonicalTwilioWebhookUrl(configuration, route),
      form,
    );
    expect(
      validateTwilioSignature({
        configuration,
        form,
        route: '/v1/webhooks/twilio/messaging/status',
        signature,
      }),
    ).toBe(false);
  });
});
