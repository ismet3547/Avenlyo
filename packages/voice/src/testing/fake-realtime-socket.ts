import type { VoiceRealtimeSocket } from '../call/types';

export class FakeRealtimeSocket implements VoiceRealtimeSocket {
  public closed = false;
  public readonly sent: Readonly<Record<string, unknown>>[] = [];
  private closeListener: (() => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;
  private messageListener: ((raw: string) => void) | null = null;

  public close(): void {
    this.closed = true;
  }

  public onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  public onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  public onMessage(listener: (raw: string) => void): void {
    this.messageListener = listener;
  }

  public send(event: Readonly<Record<string, unknown>>): void {
    this.sent.push(event);
  }

  public emitClose(): void {
    this.closeListener?.();
  }

  public emitError(error = new Error('sideband error')): void {
    this.errorListener?.(error);
  }

  public emitMessage(event: Readonly<Record<string, unknown>>): void {
    this.messageListener?.(JSON.stringify(event));
  }
}
