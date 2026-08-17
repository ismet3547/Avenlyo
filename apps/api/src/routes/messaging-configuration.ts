import type { FastifyPluginCallback } from 'fastify';

import { env, isTwilioMessagingConfigured } from '../env.js';
import { createServiceSupabaseClient } from '../lib/supabase.js';
import { TwilioSdkOutboundClient } from '../services/messaging/twilio.js';

function readEnabled(body: unknown): boolean | null {
  if (!Buffer.isBuffer(body)) return null;
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return typeof (value as { readonly enabled?: unknown }).enabled === 'boolean'
      ? (value as { readonly enabled: boolean }).enabled
      : null;
  } catch {
    return null;
  }
}

function validUuid(value: string | undefined): value is string {
  return Boolean(
    value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  );
}

/** Owner/admin SMS activation path. A browser cannot assert sender capability on its own. */
export const messagingConfigurationRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.post(
    '/v1/messaging/phone-numbers/:phoneNumberId/sms-enabled',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const phoneNumberId = (request.params as { readonly phoneNumberId?: string }).phoneNumberId;
      const enabled = readEnabled(request.body);
      if (!validUuid(phoneNumberId) || enabled === null || !request.authUser) {
        return reply.code(400).send({ code: 'INVALID_REQUEST' });
      }
      if (
        !isTwilioMessagingConfigured ||
        !env.TWILIO_ACCOUNT_SID ||
        !env.TWILIO_AUTH_TOKEN ||
        !env.TWILIO_MESSAGING_WEBHOOK_BASE_URL
      ) {
        return reply.code(503).send({ code: 'SMS_CONFIGURATION_UNAVAILABLE' });
      }
      const supabase = createServiceSupabaseClient();
      if (!supabase) return reply.code(503).send({ code: 'SMS_CONFIGURATION_UNAVAILABLE' });
      if (enabled) {
        // Read the DID only through a service-only authorization RPC, then verify it with Twilio.
        const { data: phoneNumber, error: numberError } = await supabase.rpc(
          'get_sms_phone_number_for_user',
          { target_phone_number_id: phoneNumberId, target_user_id: request.authUser.id },
        );
        if (
          numberError ||
          !phoneNumber ||
          !(await new TwilioSdkOutboundClient({
            accountSid: env.TWILIO_ACCOUNT_SID,
            authToken: env.TWILIO_AUTH_TOKEN,
            webhookBaseUrl: env.TWILIO_MESSAGING_WEBHOOK_BASE_URL,
          }).verifySmsCapability(phoneNumber))
        ) {
          return reply.code(422).send({ code: 'SMS_CAPABILITY_UNAVAILABLE' });
        }
      }
      const { error } = await supabase.rpc('set_sms_phone_number_enabled_for_user', {
        target_enabled: enabled,
        target_phone_number_id: phoneNumberId,
        target_user_id: request.authUser.id,
      });
      if (error)
        return reply
          .code(error.code === '42501' ? 403 : 400)
          .send({ code: 'SMS_CONFIGURATION_REJECTED' });
      return reply.code(204).send();
    },
  );
  done();
};
