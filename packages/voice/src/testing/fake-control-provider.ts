import type {
  RealtimeCallControlProvider,
  VoiceRealtimeSessionConfiguration,
  VoiceRealtimeSocket,
} from '../call/types';

export class FakeRealtimeCallControlProvider implements RealtimeCallControlProvider {
  public readonly accepted: Array<{ callId: string; session: VoiceRealtimeSessionConfiguration }> =
    [];
  public readonly hungUp: string[] = [];
  public readonly referred: Array<{ callId: string; target: string }> = [];
  public readonly rejected: Array<{ callId: string; statusCode: number }> = [];
  public socket: VoiceRealtimeSocket | null = null;

  public acceptCall(callId: string, session: VoiceRealtimeSessionConfiguration): Promise<void> {
    this.accepted.push({ callId, session });
    return Promise.resolve();
  }

  public connectSideband(callId: string): Promise<VoiceRealtimeSocket> {
    void callId;
    if (!this.socket) return Promise.reject(new Error('No fake sideband socket configured.'));
    return Promise.resolve(this.socket);
  }

  public hangupCall(callId: string): Promise<void> {
    this.hungUp.push(callId);
    return Promise.resolve();
  }

  public referCall(callId: string, trustedTargetE164: string): Promise<void> {
    this.referred.push({ callId, target: trustedTargetE164 });
    return Promise.resolve();
  }

  public rejectCall(callId: string, statusCode: number): Promise<void> {
    this.rejected.push({ callId, statusCode });
    return Promise.resolve();
  }
}
