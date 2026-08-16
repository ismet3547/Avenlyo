import { MAX_CALL_DURATION_MS, MAX_CONSECUTIVE_IDLE_TIMEOUTS } from './limits';
import type {
  RealtimeCallControlProvider,
  VoiceCallStatus,
  VoiceEndReason,
  VoiceRealtimeSocket,
} from './types';

export interface VoiceSessionFinalizer {
  finalize(input: {
    readonly callId: string;
    readonly endReason: VoiceEndReason;
    readonly status: VoiceCallStatus;
  }): Promise<void>;
}

interface ActiveVoiceSession {
  readonly callId: string;
  readonly durationTimer: NodeJS.Timeout;
  idleTimeouts: number;
  readonly socket: VoiceRealtimeSocket;
  finalization: Promise<void> | null;
}

export interface VoiceSessionManagerOptions {
  readonly control: RealtimeCallControlProvider;
  readonly finalizer: VoiceSessionFinalizer;
  readonly maxCallDurationMs?: number;
}

/**
 * An intentionally in-process coordinator for one Fastify process. The database is durable, but
 * a process restart ends active sideband orchestration and is handled by provider cleanup.
 */
export class VoiceSessionManager {
  private readonly sessions = new Map<string, ActiveVoiceSession>();
  private readonly maxCallDurationMs: number;

  public constructor(private readonly options: VoiceSessionManagerOptions) {
    this.maxCallDurationMs = options.maxCallDurationMs ?? MAX_CALL_DURATION_MS;
  }

  public has(callId: string): boolean {
    return this.sessions.has(callId);
  }

  /** Returns false when a webhook replay already owns this call's sideband session. */
  public start(callId: string, socket: VoiceRealtimeSocket): boolean {
    if (this.sessions.has(callId)) return false;
    const durationTimer = setTimeout(() => {
      void this.finish(callId, 'completed', 'hard_duration_limit', true);
    }, this.maxCallDurationMs);
    const session: ActiveVoiceSession = {
      callId,
      durationTimer,
      finalization: null,
      idleTimeouts: 0,
      socket,
    };
    this.sessions.set(callId, session);
    socket.onClose(() => {
      // A sideband loss is not evidence that the SIP leg has ended. Fail closed so an
      // orphaned provider call cannot continue without Avenlyo's trusted orchestrator.
      void this.finish(callId, 'completed', 'sideband_closed', true);
    });
    socket.onError(() => {
      void this.finish(callId, 'failed', 'provider_error', true);
    });
    return true;
  }

  public recordActivity(callId: string): void {
    const session = this.sessions.get(callId);
    if (session) session.idleTimeouts = 0;
  }

  /** The first provider idle event is normal; a repeated one ends the call safely. */
  public recordIdleTimeout(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session) return;
    session.idleTimeouts += 1;
    if (session.idleTimeouts >= MAX_CONSECUTIVE_IDLE_TIMEOUTS) {
      void this.finish(callId, 'completed', 'idle_timeout', true);
    }
  }

  public async finalizeTransferred(callId: string): Promise<void> {
    await this.finish(callId, 'transferred', 'transfer', false);
  }

  public async finalizeFailed(callId: string): Promise<void> {
    await this.finish(callId, 'failed', 'provider_error', true);
  }

  public async shutdown(): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()].map((callId) => this.finish(callId, 'completed', 'unknown', true)),
    );
  }

  private async finish(
    callId: string,
    status: VoiceCallStatus,
    endReason: VoiceEndReason,
    shouldHangup: boolean,
  ): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) return;
    if (session.finalization) return session.finalization;
    session.finalization = (async () => {
      clearTimeout(session.durationTimer);
      this.sessions.delete(callId);
      if (shouldHangup) {
        try {
          await this.options.control.hangupCall(callId);
        } catch {
          // Durable finalization still runs; the provider may have already ended the leg.
        }
      }
      session.socket.close();
      await this.options.finalizer.finalize({ callId, endReason, status });
    })();
    return session.finalization;
  }
}
