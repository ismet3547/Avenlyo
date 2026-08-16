import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

import type { RecentVoiceCall, VoiceConfigurationView } from './types';

interface VoiceRpcCaller {
  (
    name: 'get_my_voice_configuration',
    args: { target_location_id: string },
  ): PromiseLike<{
    data:
      | {
          assigned_phone_number: string | null;
          enabled: boolean;
          provider_transfer_enabled: boolean;
          realtime_model_status: string;
          transfer_enabled: boolean;
          transfer_target_e164: string | null;
          voice: string;
        }[]
      | null;
    error: { message: string } | null;
  }>;
  (
    name: 'get_my_recent_voice_calls',
    args: { target_location_id: string },
  ): PromiseLike<{
    data:
      | {
          answered_at: string | null;
          call_id: string;
          caller_phone: string | null;
          end_reason: string | null;
          ended_at: string | null;
          handoff_requested: boolean;
          started_at: string | null;
          status: string;
        }[]
      | null;
    error: { message: string } | null;
  }>;
  (
    name: 'upsert_my_voice_configuration',
    args: {
      target_enabled: boolean;
      target_location_id: string;
      target_transfer_enabled: boolean;
      target_transfer_target_e164: string;
      target_voice: string;
    },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
}

function voiceRpc(client: AvenlyoSupabaseClient): VoiceRpcCaller {
  // This keeps the older @supabase/ssr generic binding compatible with generated RPC types.
  return client.rpc.bind(client);
}

export class VoiceConfigurationError extends Error {
  public constructor(message = 'Voice settings could not be updated.') {
    super(message);
    this.name = 'VoiceConfigurationError';
  }
}

export async function loadVoiceConfiguration(
  client: AvenlyoSupabaseClient,
  locationId: string,
): Promise<VoiceConfigurationView | null> {
  const { data, error } = await voiceRpc(client)('get_my_voice_configuration', {
    target_location_id: locationId,
  });
  if (error) throw new VoiceConfigurationError('Voice settings could not be loaded.');
  const row = data?.[0];
  return row
    ? {
        assignedPhoneNumber: row.assigned_phone_number,
        enabled: row.enabled,
        providerTransferEnabled: row.provider_transfer_enabled,
        realtimeModelStatus: row.realtime_model_status,
        transferEnabled: row.transfer_enabled,
        transferTargetE164: row.transfer_target_e164,
        voice: row.voice,
      }
    : null;
}

export async function loadRecentVoiceCalls(
  client: AvenlyoSupabaseClient,
  locationId: string,
): Promise<readonly RecentVoiceCall[]> {
  const { data, error } = await voiceRpc(client)('get_my_recent_voice_calls', {
    target_location_id: locationId,
  });
  if (error) throw new VoiceConfigurationError('Recent calls could not be loaded.');
  return (data ?? []).map((row) => ({
    answeredAt: row.answered_at,
    callerPhone: row.caller_phone,
    endReason: row.end_reason,
    endedAt: row.ended_at,
    handoffRequested: row.handoff_requested,
    id: row.call_id,
    startedAt: row.started_at,
    status: row.status,
  }));
}

export async function saveVoiceConfiguration(
  client: AvenlyoSupabaseClient,
  input: {
    readonly enabled: boolean;
    readonly locationId: string;
    readonly transferEnabled: boolean;
    readonly transferTargetE164: string;
    readonly voice: string;
  },
): Promise<void> {
  const { error } = await voiceRpc(client)('upsert_my_voice_configuration', {
    target_enabled: input.enabled,
    target_location_id: input.locationId,
    target_transfer_enabled: input.transferEnabled,
    target_transfer_target_e164: input.transferTargetE164,
    target_voice: input.voice,
  });
  if (error) throw new VoiceConfigurationError();
}
