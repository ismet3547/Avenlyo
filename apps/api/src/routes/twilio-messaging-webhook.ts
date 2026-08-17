import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { isTwilioMessageSid, normalizeE164 } from '@avenlyo/messaging';

import { env, isTwilioMessagingConfigured } from '../env.js';
import { createServiceSupabaseClient } from '../lib/supabase.js';
import { validateTwilioSignature, type TwilioFormFields } from '../services/messaging/twilio.js';

const inboundRoute = '/v1/webhooks/twilio/messaging/inbound' as const;
const statusRoute = '/v1/webhooks/twilio/messaging/status' as const;
const twimlEmptyResponse = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function formFields(request: FastifyRequest): TwilioFormFields | null {
  if (!request.body || typeof request.body !== 'object' || Buffer.isBuffer(request.body))
    return null;
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.body as Record<string, unknown>)) {
    if (typeof value !== 'string') return null;
    fields[key] = value;
  }
  return fields;
}

function mediaMetadata(form: TwilioFormFields): readonly Record<string, string>[] {
  const count = Math.min(10, Number.parseInt(form.NumMedia ?? '0', 10) || 0);
  return Array.from({ length: count }, (_, index) => ({
    content_type: form[`MediaContentType${index}`] ?? '',
    url: form[`MediaUrl${index}`] ?? '',
  })).filter((media) => media.url.length > 0);
}

function formMetadata(form: TwilioFormFields): Record<string, string> {
  const permitted = ['AccountSid', 'MessagingServiceSid', 'ProfileName', 'SmsStatus', 'WaId'];
  return Object.fromEntries(
    permitted.flatMap((key) => (form[key] ? [[key, form[key]] as const] : [])),
  );
}

const statusPayload = z.object({
  ErrorCode: z.string().max(40).optional(),
  MessageSid: z.string(),
  MessageStatus: z.enum(['queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered']),
});

export const twilioMessagingWebhookRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.post(inboundRoute, async (request, reply) => {
    if (
      !isTwilioMessagingConfigured ||
      !env.TWILIO_AUTH_TOKEN ||
      !env.TWILIO_MESSAGING_WEBHOOK_BASE_URL
    ) {
      return reply.code(503).send({ code: 'MESSAGING_NOT_CONFIGURED' });
    }
    const form = formFields(request);
    const signature = request.headers['x-twilio-signature'];
    if (
      !form ||
      !validateTwilioSignature({
        configuration: {
          authToken: env.TWILIO_AUTH_TOKEN,
          webhookBaseUrl: env.TWILIO_MESSAGING_WEBHOOK_BASE_URL,
        },
        form,
        route: inboundRoute,
        signature: typeof signature === 'string' ? signature : undefined,
      })
    ) {
      return reply.code(403).send({ code: 'INVALID_TWILIO_SIGNATURE' });
    }
    const messageSid = form.MessageSid ?? '';
    const from = normalizeE164(form.From);
    const to = normalizeE164(form.To);
    if (!isTwilioMessageSid(messageSid) || !from || !to || (form.Body?.length ?? 0) > 2000) {
      return reply.code(400).send({ code: 'INVALID_SMS_PAYLOAD' });
    }
    const supabase = createServiceSupabaseClient();
    if (!supabase) return reply.code(503).send({ code: 'MESSAGING_NOT_CONFIGURED' });
    const { error } = await supabase.rpc('bootstrap_inbound_sms', {
      target_body: form.Body ?? '',
      target_from_e164: from,
      target_media: [...mediaMetadata(form)],
      target_message_sid: messageSid,
      target_provider_metadata: formMetadata(form),
      target_to_e164: to,
    });
    if (error) {
      request.log.error(
        { code: error.code, message: error.message },
        'Inbound SMS persistence failed',
      );
      return reply.code(500).send({ code: 'SMS_PERSISTENCE_FAILED' });
    }
    return reply.type('text/xml').send(twimlEmptyResponse);
  });

  app.post(statusRoute, async (request, reply) => {
    if (
      !isTwilioMessagingConfigured ||
      !env.TWILIO_AUTH_TOKEN ||
      !env.TWILIO_MESSAGING_WEBHOOK_BASE_URL
    ) {
      return reply.code(503).send({ code: 'MESSAGING_NOT_CONFIGURED' });
    }
    const form = formFields(request);
    const signature = request.headers['x-twilio-signature'];
    if (
      !form ||
      !validateTwilioSignature({
        configuration: {
          authToken: env.TWILIO_AUTH_TOKEN,
          webhookBaseUrl: env.TWILIO_MESSAGING_WEBHOOK_BASE_URL,
        },
        form,
        route: statusRoute,
        signature: typeof signature === 'string' ? signature : undefined,
      })
    ) {
      return reply.code(403).send({ code: 'INVALID_TWILIO_SIGNATURE' });
    }
    const parsed = statusPayload.safeParse(form);
    if (!parsed.success || !isTwilioMessageSid(parsed.data.MessageSid)) {
      return reply.code(400).send({ code: 'INVALID_SMS_STATUS' });
    }
    const supabase = createServiceSupabaseClient();
    if (!supabase) return reply.code(503).send({ code: 'MESSAGING_NOT_CONFIGURED' });
    const { error } = await supabase.rpc('record_twilio_message_status', {
      target_error_code: parsed.data.ErrorCode ?? null,
      target_provider_message_id: parsed.data.MessageSid,
      target_status: parsed.data.MessageStatus,
    });
    if (error) {
      request.log.error(
        { code: error.code, message: error.message },
        'SMS status persistence failed',
      );
      return reply.code(500).send({ code: 'SMS_STATUS_PERSISTENCE_FAILED' });
    }
    return reply.code(204).send();
  });
  done();
};
