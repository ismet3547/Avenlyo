import { z } from 'zod';

export const sipHeaderSchema = z
  .object({ name: z.string().min(1).max(256), value: z.string().max(4_096) })
  .strict();

/** The only OpenAI webhook event that Phase 4 acts upon. */
export const incomingRealtimeCallEventSchema = z
  .object({
    created_at: z.number().int().nonnegative(),
    data: z
      .object({
        call_id: z.string().min(1).max(256),
        sip_headers: z.array(sipHeaderSchema).max(128),
      })
      .strict(),
    id: z.string().min(1).max(256),
    object: z.literal('event').optional(),
    type: z.literal('realtime.call.incoming'),
  })
  .strict();

export type IncomingRealtimeCallEvent = z.infer<typeof incomingRealtimeCallEventSchema>;

const finalCallerTranscriptSchema = z
  .object({
    event_id: z.string().min(1).max(256),
    item_id: z.string().min(1).max(256),
    transcript: z.string().max(16_000),
    type: z.literal('conversation.item.input_audio_transcription.completed'),
  })
  .passthrough();

const finalAssistantTranscriptSchema = z
  .object({
    event_id: z.string().min(1).max(256),
    item_id: z.string().min(1).max(256),
    response_id: z.string().min(1).max(256).optional(),
    transcript: z.string().max(16_000),
    type: z.literal('response.output_audio_transcript.done'),
  })
  .passthrough();

const functionCallSchema = z
  .object({
    arguments: z.string().max(16_000),
    call_id: z.string().min(1).max(256),
    event_id: z.string().min(1).max(256),
    name: z.string().min(1).max(128),
    type: z.literal('response.function_call_arguments.done'),
  })
  .passthrough();

const responseCreatedSchema = z
  .object({
    event_id: z.string().min(1).max(256),
    response: z
      .object({
        id: z.string().min(1).max(256),
        metadata: z.record(z.string(), z.unknown()).nullable().optional(),
      })
      .passthrough(),
    type: z.literal('response.created'),
  })
  .passthrough();

const outputAudioBufferStoppedSchema = z
  .object({
    event_id: z.string().min(1).max(256),
    response_id: z.string().min(1).max(256),
    type: z.literal('output_audio_buffer.stopped'),
  })
  .passthrough();

const idleTimeoutSchema = z
  .object({ type: z.literal('input_audio_buffer.timeout_triggered') })
  .passthrough();

export const sidebandEventSchema = z.discriminatedUnion('type', [
  finalCallerTranscriptSchema,
  finalAssistantTranscriptSchema,
  functionCallSchema,
  responseCreatedSchema,
  outputAudioBufferStoppedSchema,
  idleTimeoutSchema,
]);

export type SidebandEvent = z.infer<typeof sidebandEventSchema>;
