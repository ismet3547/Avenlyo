import type { IndustryPack } from '@avenlyo/industries';

export type VoiceCallStatus =
  'initiated' | 'ringing' | 'in_progress' | 'transferred' | 'completed' | 'failed' | 'rejected';

export type VoiceEndReason =
  | 'caller_hangup'
  | 'hard_duration_limit'
  | 'idle_timeout'
  | 'provider_error'
  | 'sideband_closed'
  | 'transfer'
  | 'unknown';

export interface VoiceBusinessContext {
  readonly address: string | null;
  readonly businessHours: string | null;
  readonly name: string;
  readonly phone: string | null;
  readonly timezone: string;
  readonly website: string | null;
  readonly locationName: string | null;
}

/** Trusted identity created only after DID routing and database bootstrap. */
export interface VoiceCallContext {
  readonly callId: string;
  readonly conversationId: string;
  readonly contactId: string | null;
  readonly industry: IndustryPack;
  readonly locationId: string;
  readonly organizationId: string;
  readonly phoneNumberId: string;
}

export interface VoiceConfiguration {
  readonly enabled: boolean;
  readonly providerTransferEnabled: boolean;
  readonly transferEnabled: boolean;
  readonly transferTargetE164: string | null;
  readonly voice: string;
}

export interface VoiceRealtimeSessionConfiguration {
  readonly business: VoiceBusinessContext;
  readonly greeting: string;
  readonly instructions: string;
  readonly model: string;
  readonly tools: readonly VoiceFunctionTool[];
  readonly voice: string;
}

export interface VoiceFunctionTool {
  readonly description: string;
  readonly name: 'request_human_help' | 'search_business_knowledge' | 'transfer_call';
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: true;
}

export interface VoiceRealtimeSocket {
  close(): void;
  onClose(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  onMessage(listener: (raw: string) => void): void;
  send(event: Readonly<Record<string, unknown>>): void;
}

/** OpenAI transport details stay behind this interface. */
export interface RealtimeCallControlProvider {
  acceptCall(callId: string, session: VoiceRealtimeSessionConfiguration): Promise<void>;
  connectSideband(callId: string): Promise<VoiceRealtimeSocket>;
  hangupCall(callId: string): Promise<void>;
  referCall(callId: string, trustedTargetE164: string): Promise<void>;
  rejectCall(callId: string, statusCode: number): Promise<void>;
}

export interface VoiceToolCall {
  readonly arguments: string;
  readonly callId: string;
  readonly name: string;
}

export interface VoiceToolExecution {
  readonly handoffRequested: boolean;
  readonly modelOutput: string;
  readonly status: 'failed' | 'rejected' | 'succeeded';
  readonly summary: string;
  readonly transferred: boolean;
}
