import { describe, expect, it } from 'vitest';

import { extractCallerE164, extractTwilioDiversionDid } from './sip';

describe('Twilio SIP routing headers', () => {
  it('uses the first valid Diversion DID, never To or tenant-looking headers', () => {
    const headers = [
      { name: 'To', value: '<sip:proj_123@sip.api.openai.com>' },
      { name: 'X-Organization-ID', value: 'forged-tenant' },
      {
        name: 'DIVERSION',
        value: '"Main line" <sip:+14155550123@twilio.example>;reason=unconditional',
      },
      { name: 'Diversion', value: '<sip:+14155550999@twilio.example>' },
    ];

    expect(extractTwilioDiversionDid(headers)).toBe('+14155550123');
  });

  it('skips invalid Diversion values and supports a tel URI', () => {
    expect(
      extractTwilioDiversionDid([
        { name: 'Diversion', value: '<sip:project@sip.api.openai.com>' },
        { name: 'diversion', value: '<tel:+442071838750>' },
      ]),
    ).toBe('+442071838750');
  });

  it('does not manufacture caller identity for anonymous or malformed From headers', () => {
    expect(
      extractCallerE164([{ name: 'From', value: 'Anonymous <sip:anonymous@invalid>' }]),
    ).toBeNull();
    expect(
      extractCallerE164([{ name: 'from', value: '<sip:private@carrier.example>' }]),
    ).toBeNull();
    expect(extractCallerE164([{ name: 'FROM', value: '<sip:+14155550124@carrier.example>' }])).toBe(
      '+14155550124',
    );
  });
});
