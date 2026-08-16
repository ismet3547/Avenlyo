export interface VoiceConfigurationView {
  readonly assignedPhoneNumber: string | null;
  readonly enabled: boolean;
  readonly providerTransferEnabled: boolean;
  readonly realtimeModelStatus: string;
  readonly transferEnabled: boolean;
  readonly transferTargetE164: string | null;
  readonly voice: string;
}

export interface RecentVoiceCall {
  readonly answeredAt: string | null;
  readonly callerPhone: string | null;
  readonly endReason: string | null;
  readonly endedAt: string | null;
  readonly handoffRequested: boolean;
  readonly id: string;
  readonly startedAt: string | null;
  readonly status: string;
}
