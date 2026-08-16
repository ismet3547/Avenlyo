import OpenAI from 'openai';
import WebSocket from 'ws';

import type {
  RealtimeCallControlProvider,
  VoiceRealtimeSessionConfiguration,
  VoiceRealtimeSocket,
} from '@avenlyo/voice';
import { VOICE_IDLE_TIMEOUT_MS } from '@avenlyo/voice';

interface OpenAIRealtimeCallControlProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly projectId?: string;
}

class OpenAIRealtimeSocket implements VoiceRealtimeSocket {
  public constructor(private readonly socket: WebSocket) {}

  public close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }

  public onClose(listener: () => void): void {
    this.socket.on('close', listener);
  }

  public onError(listener: (error: Error) => void): void {
    this.socket.on('error', listener);
  }

  public onMessage(listener: (raw: string) => void): void {
    this.socket.on('message', (data) => listener(rawDataToText(data)));
  }

  public send(event: Readonly<Record<string, unknown>>): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Realtime sideband socket is not open.');
    }
    this.socket.send(JSON.stringify(event));
  }
}

function rawDataToText(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/**
 * OpenAI's REST call-control and sideband WebSocket adapter. It deliberately owns no
 * tenant identity; callers supply only IDs produced by verified OpenAI webhooks.
 */
export class OpenAIRealtimeCallControlProvider implements RealtimeCallControlProvider {
  private readonly client: OpenAI;

  public constructor(private readonly options: OpenAIRealtimeCallControlProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 0,
      timeout: 10_000,
      ...(options.projectId ? { project: options.projectId } : {}),
    });
  }

  public async acceptCall(
    callId: string,
    session: VoiceRealtimeSessionConfiguration,
  ): Promise<void> {
    await this.client.realtime.calls.accept(callId, {
      audio: {
        input: {
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: {
            create_response: true,
            idle_timeout_ms: VOICE_IDLE_TIMEOUT_MS,
            interrupt_response: true,
            silence_duration_ms: 700,
            type: 'server_vad',
          },
        },
        output: { voice: session.voice },
      },
      instructions: session.instructions,
      max_output_tokens: 700,
      model: session.model,
      output_modalities: ['audio'],
      parallel_tool_calls: false,
      tool_choice: 'auto',
      tools: session.tools.map((tool) => ({
        description: tool.description,
        name: tool.name,
        parameters: tool.parameters,
        type: 'function' as const,
      })),
      tracing: null,
      type: 'realtime',
    });
  }

  public async connectSideband(callId: string): Promise<VoiceRealtimeSocket> {
    const url = new URL('wss://api.openai.com/v1/realtime');
    url.searchParams.set('call_id', callId);
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        ...(this.options.projectId ? { 'OpenAI-Project': this.options.projectId } : {}),
      },
      handshakeTimeout: 10_000,
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        socket.off('open', onOpen);
        socket.off('error', onError);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
    return new OpenAIRealtimeSocket(socket);
  }

  public async hangupCall(callId: string): Promise<void> {
    await this.client.realtime.calls.hangup(callId);
  }

  public async referCall(callId: string, trustedTargetE164: string): Promise<void> {
    await this.client.realtime.calls.refer(callId, { target_uri: `tel:${trustedTargetE164}` });
  }

  public async rejectCall(callId: string, statusCode: number): Promise<void> {
    await this.client.realtime.calls.reject(callId, { status_code: statusCode });
  }
}
