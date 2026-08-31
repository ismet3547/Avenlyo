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

  it('fails closed when an unexpected sideband close occurs', async () => {
    const control = new FakeRealtimeCallControlProvider();
    const finalize = vi.fn().mockResolvedValue(undefined);
    const manager = new VoiceSessionManager({ control, finalizer: { finalize } });
    const socket = new FakeRealtimeSocket();
    manager.start('rtc_closed', socket);

    socket.emitClose();
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());

    expect(control.hungUp).toEqual(['rtc_closed']);
    expect(finalize).toHaveBeenCalledWith({
      callId: 'rtc_closed',
      endReason: 'sideband_closed',
      status: 'completed',
    });
  });

  it('fails closed once when sideband error and close callbacks repeat', async () => {
    const control = new FakeRealtimeCallControlProvider();
    const finalize = vi.fn().mockResolvedValue(undefined);
    const manager = new VoiceSessionManager({ control, finalizer: { finalize } });
    const socket = new FakeRealtimeSocket();
    manager.start('rtc_error', socket);

    socket.emitError();
    socket.emitClose();
    socket.emitError();
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());

    expect(control.hungUp).toEqual(['rtc_error']);
    expect(finalize).toHaveBeenCalledWith({
      callId: 'rtc_error',
      endReason: 'provider_error',
      status: 'failed',
    });
  });

  it('hangs up once after a durable handoff acknowledgement finishes', async () => {
    const control = new FakeRealtimeCallControlProvider();
    const finalize = vi.fn().mockResolvedValue(undefined);
    const manager = new VoiceSessionManager({ control, finalizer: { finalize } });
    const socket = new FakeRealtimeSocket();
    manager.start('rtc_handoff', socket);

    await manager.finalizeHandoff('rtc_handoff');
    await manager.finalizeHandoff('rtc_handoff');
    socket.emitClose();
    socket.emitError();

    expect(control.hungUp).toEqual(['rtc_handoff']);
    expect(socket.closed).toBe(true);
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith({
      callId: 'rtc_handoff',
      endReason: 'handoff',
      status: 'completed',
    });
    expect(manager.has('rtc_handoff')).toBe(false);
  });

  it('does not hang up after an intentional transfer', async () => {
    const control = new FakeRealtimeCallControlProvider();
    const finalize = vi.fn().mockResolvedValue(undefined);
    const manager = new VoiceSessionManager({ control, finalizer: { finalize } });
    const socket = new FakeRealtimeSocket();
    manager.start('rtc_transferred', socket);

    await manager.finalizeTransferred('rtc_transferred');
    socket.emitClose();
    socket.emitError();

    expect(control.hungUp).toEqual([]);
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith({
      callId: 'rtc_transferred',
      endReason: 'transfer',
      status: 'transferred',
    });
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
