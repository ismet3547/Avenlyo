import { OpenAIEmbeddingProvider } from '@avenlyo/knowledge';
import { resolveIndustryPack } from '@avenlyo/industries';
import {
  activeVoiceTools,
  buildVoiceInstructions,
  extractCallerE164,
  extractTwilioDiversionDid,
  initialVoiceGreeting,
  type IncomingRealtimeCallEvent,
  type RealtimeCallControlProvider,
  type VoiceBusinessContext,
  type VoiceCallContext,
  type VoiceConfiguration,
  type VoiceSessionManager,
  type VoiceSchedulingServices,
} from '@avenlyo/voice';

import { VoiceSidebandRuntime } from './sideband-runtime.js';
import type { VoiceStore } from './store.js';
import { customerVisibleVoiceTools } from './tool-authority.js';

export interface VoiceInboundCallServiceOptions {
  readonly control: RealtimeCallControlProvider;
  readonly embed?: (query: string) => Promise<readonly number[]>;
  readonly model: string;
  readonly sessions: VoiceSessionManager;
  readonly scheduling?: VoiceSchedulingServices;
  readonly store: VoiceStore;
}

export type VoiceIncomingResult = 'accepted' | 'duplicate' | 'rejected';

function describeJson(value: Record<string, unknown> | null): string | null {
  if (!value) return null;
  return JSON.stringify(value);
}

function requireBootstrapContext(
  bootstrap: Awaited<ReturnType<VoiceStore['bootstrapIncomingCall']>>,
): {
  readonly business: VoiceBusinessContext;
  readonly configuration: VoiceConfiguration;
  readonly context: VoiceCallContext;
} | null {
  if (
    !bootstrap?.accepted ||
    !bootstrap.callRecordId ||
    !bootstrap.conversationId ||
    !bootstrap.locationId ||
    !bootstrap.organizationId ||
    !bootstrap.phoneNumberId ||
    !bootstrap.primaryIndustryId ||
    !bootstrap.organizationName ||
    !bootstrap.locationTimezone ||
    !bootstrap.voice
  ) {
    return null;
  }
  const industry = resolveIndustryPack(bootstrap.primaryIndustryId);
  if (!industry) return null;
  const business: VoiceBusinessContext = {
    address: describeJson(bootstrap.locationAddress),
    businessHours: describeJson(bootstrap.businessHours),
    locationName: bootstrap.locationName,
    name: bootstrap.organizationName,
    phone: bootstrap.businessPhone,
    timezone: bootstrap.locationTimezone,
    website: bootstrap.websiteUrl,
  };
  const configuration: VoiceConfiguration = {
    enabled: true,
    providerTransferEnabled: bootstrap.providerTransferEnabled,
    transferEnabled: bootstrap.transferEnabled,
    transferTargetE164: bootstrap.transferTargetE164,
    voice: bootstrap.voice,
  };
  return {
    business,
    configuration,
    context: {
      callId: '',
      contactId: bootstrap.contactId,
      conversationId: bootstrap.conversationId,
      industry,
      locationId: bootstrap.locationId,
      organizationId: bootstrap.organizationId,
      phoneNumberId: bootstrap.phoneNumberId,
    },
  };
}

/** Coordinates a verified incoming webhook. It accepts no routing identity from JSON/model input. */
export class VoiceInboundCallService {
  private readonly embed: (query: string) => Promise<readonly number[]>;

  public constructor(private readonly options: VoiceInboundCallServiceOptions) {
    const provider = options.embed ? null : new OpenAIEmbeddingProvider();
    this.embed =
      options.embed ?? ((query) => provider!.embed([query]).then(([vector]) => vector ?? []));
  }

  public async handleIncoming(event: IncomingRealtimeCallEvent): Promise<VoiceIncomingResult> {
    const dialedE164 = extractTwilioDiversionDid(event.data.sip_headers);
    const callerE164 = extractCallerE164(event.data.sip_headers);
    const bootstrap = await this.options.store.bootstrapIncomingCall({
      callerE164,
      dialedE164,
      eventId: event.id,
      externalCallId: event.data.call_id,
      sipCallId: event.data.call_id,
    });
    if (bootstrap?.isDuplicate) return 'duplicate';
    const resolved = requireBootstrapContext(bootstrap);
    if (!resolved) {
      await this.reject(event.data.call_id);
      return 'rejected';
    }
    const context: VoiceCallContext = { ...resolved.context, callId: event.data.call_id };
    const transferAvailable =
      resolved.configuration.transferEnabled &&
      resolved.configuration.providerTransferEnabled &&
      resolved.configuration.transferTargetE164 !== null;
    const schedulingEnabled = await this.schedulingEnabled(context);
    const greeting = initialVoiceGreeting(resolved.business.name);
    try {
      await this.options.control.acceptCall(event.data.call_id, {
        business: resolved.business,
        greeting,
        instructions: buildVoiceInstructions(context, resolved.business),
        model: this.options.model,
        tools: customerVisibleVoiceTools(
          activeVoiceTools({
            industry: context.industry,
            schedulingEnabled,
            transferEnabled: transferAvailable,
          }),
        ),
        voice: resolved.configuration.voice,
      });
      const socket = await this.options.control.connectSideband(event.data.call_id);
      if (!this.options.sessions.start(event.data.call_id, socket)) {
        socket.close();
        return 'duplicate';
      }
      const runtime = new VoiceSidebandRuntime({
        configuration: resolved.configuration,
        context,
        control: this.options.control,
        embed: this.embed,
        sessions: this.options.sessions,
        ...(schedulingEnabled && this.options.scheduling
          ? { scheduling: this.options.scheduling }
          : {}),
        socket,
        store: this.options.store,
      });
      runtime.attach();
      await this.options.store.markCallActive(event.data.call_id);
      runtime.startGreeting(greeting);
      return 'accepted';
    } catch {
      if (this.options.sessions.has(event.data.call_id)) {
        await this.options.sessions.finalizeFailed(event.data.call_id);
      } else {
        await this.options.store.finalizeCall({
          externalCallId: event.data.call_id,
          endReason: 'provider_error',
          status: 'failed',
        });
        try {
          await this.options.control.hangupCall(event.data.call_id);
        } catch {
          // The provider may have already terminated the call.
        }
      }
      return 'rejected';
    }
  }

  private async reject(callId: string): Promise<void> {
    try {
      await this.options.control.rejectCall(callId, 404);
    } catch {
      // A caller must not be accepted just because the rejection control path was unavailable.
    }
  }

  private async schedulingEnabled(context: VoiceCallContext): Promise<boolean> {
    if (!this.options.scheduling) return false;
    try {
      return await this.options.scheduling.isEnabledForCall(context);
    } catch {
      return false;
    }
  }
}
