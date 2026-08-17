import twilio from 'twilio';

import { isTwilioMessageSid, twilioWebhookUrl } from '@avenlyo/messaging';

export interface TwilioMessagingConfiguration {
  readonly accountSid: string;
  readonly authToken: string;
  readonly webhookBaseUrl: string;
}

export type TwilioFormFields = Readonly<Record<string, string>>;

export function canonicalTwilioWebhookUrl(
  configuration: Pick<TwilioMessagingConfiguration, 'webhookBaseUrl'>,
  route: '/v1/webhooks/twilio/messaging/inbound' | '/v1/webhooks/twilio/messaging/status',
): string {
  return twilioWebhookUrl(configuration.webhookBaseUrl, route);
}

/** Delegates validation to Twilio's maintained SDK and always includes every form field. */
export function validateTwilioSignature(input: {
  readonly configuration: Pick<TwilioMessagingConfiguration, 'authToken' | 'webhookBaseUrl'>;
  readonly form: TwilioFormFields;
  readonly route: '/v1/webhooks/twilio/messaging/inbound' | '/v1/webhooks/twilio/messaging/status';
  readonly signature: string | undefined;
}): boolean {
  if (!input.signature) return false;
  return twilio.validateRequest(
    input.configuration.authToken,
    input.signature,
    canonicalTwilioWebhookUrl(input.configuration, input.route),
    input.form,
  );
}

export interface TwilioOutboundMessage {
  readonly body: string;
  readonly from: string;
  readonly to: string;
}

export interface TwilioOutboundClient {
  send(input: TwilioOutboundMessage): Promise<{
    readonly messageSid: string;
    readonly providerStatus: string;
  }>;
  verifySmsCapability(phoneNumber: string): Promise<boolean>;
}

/** The only code path permitted to make an outbound SMS request. Destination data is DB-derived. */
export class TwilioSdkOutboundClient implements TwilioOutboundClient {
  private readonly client: ReturnType<typeof twilio>;

  public constructor(private readonly configuration: TwilioMessagingConfiguration) {
    this.client = twilio(configuration.accountSid, configuration.authToken);
  }

  public async send(input: TwilioOutboundMessage): Promise<{
    readonly messageSid: string;
    readonly providerStatus: string;
  }> {
    const result = await this.client.messages.create({
      body: input.body,
      from: input.from,
      statusCallback: canonicalTwilioWebhookUrl(
        this.configuration,
        '/v1/webhooks/twilio/messaging/status',
      ),
      to: input.to,
    });
    if (!isTwilioMessageSid(result.sid)) throw new Error('Twilio returned an invalid message SID.');
    return { messageSid: result.sid, providerStatus: result.status };
  }

  public async verifySmsCapability(phoneNumber: string): Promise<boolean> {
    const numbers = await this.client.incomingPhoneNumbers.list({ limit: 1, phoneNumber });
    const number = numbers[0] as unknown;
    if (!number || typeof number !== 'object' || Array.isArray(number)) return false;
    const capabilities = (number as { readonly capabilities?: unknown }).capabilities;
    return Boolean(
      capabilities &&
      typeof capabilities === 'object' &&
      !Array.isArray(capabilities) &&
      (capabilities as { readonly sms?: unknown }).sms === true,
    );
  }
}
