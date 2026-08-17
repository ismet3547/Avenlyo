import { describe, expect, it } from 'vitest';

import { formMetadata, mediaMetadata } from './twilio-messaging-webhook.js';

describe('Twilio messaging webhook normalization', () => {
  it('does not retain a Twilio MediaUrl', () => {
    expect(
      mediaMetadata({
        MediaContentType0: 'image/jpeg',
        MediaUrl0: 'https://api.twilio.test/private-media',
        NumMedia: '1',
      }),
    ).toEqual([{ content_type: 'image/jpeg' }]);
  });

  it.each(['STOP', 'START', 'HELP'])('normalizes trusted OptOutType %s', (optOutType) => {
    expect(formMetadata({ Body: 'unrelated body', OptOutType: optOutType }).opt_out_type).toBe(
      optOutType.toLowerCase(),
    );
  });

  it('does not treat unrecognized provider metadata as an opt-out command', () => {
    expect(formMetadata({ OptOutType: 'YES' }).opt_out_type).toBeUndefined();
  });
});
