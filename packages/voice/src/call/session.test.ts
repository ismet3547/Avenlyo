import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeRealtimeCallControlProvider } from '../testing/fake-control-provider';
import { FakeRealtimeSocket } from '../testing/fake-realtime-socket';
import { VoiceSessionManager } from './session';

describe('VoiceSessionManager', () => {
  afterEach(() => vi.useRealTimers());

  it('hangs up and finalizes once at the hard duration limit', async () => {
    vi.useFakeTimers();
    const control = new FakeRealtimeCallControlProvider();
    const finalize = vi.fn().mockResolvedValue(undefined);
    const manager = new VoiceSessionManager({
      control,
      finalizer: { finalize },
      maxCallDurationMs: 50,
    });
    const socket = new FakeRealtimeSocket();
    expect(manager.start('rtc_1', socket)).toBe(true);

    await vi.advanceTimersByTimeAsync(50);
    expect(control.hungUp).toEqual(['rtc_1']);
    expect(finalize).toHaveBeenCalledWith({
      callId: 'rtc_1',
      endReason: 'hard_duration_limit',
      status: 'completed',
    });
    socket.emitClose();
    expect(finalize).toHaveBeenCalledOnce();
    expect(manager.has('rtc_1')).toBe(false);
  });

  it('does not close after one idle event but does after the second', async () => {
    const control = new FakeRealtimeCallControlProvider();
    const finalize = vi.fn().mockResolvedValue(undefined);
    const manager = new VoiceSessionManager({ control, finalizer: { finalize } });
    const socket = new FakeRealtimeSocket();
    manager.start('rtc_2', socket);
    manager.recordIdleTimeout('rtc_2');
    await Promise.resolve();
    expect(finalize).not.toHaveBeenCalled();
    manager.recordIdleTimeout('rtc_2');
    await Promise.resolve();
    expect(control.hungUp).toEqual(['rtc_2']);
    expect(finalize).toHaveBeenCalledWith({
      callId: 'rtc_2',
      endReason: 'idle_timeout',
      status: 'completed',
    });
  });
});
