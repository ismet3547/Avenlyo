import { describe, expect, it, vi } from 'vitest';

import { registerGracefulShutdown } from './shutdown.js';

function handleFor(overrides: Partial<Parameters<typeof registerGracefulShutdown>[0]> = {}) {
  const order: string[] = [];
  const drain = vi.fn(async () => {
    order.push('drain');
    await Promise.resolve();
  });
  const markDraining = vi.fn(() => void order.push('mark_draining'));
  const stopHttp = vi.fn(async () => {
    order.push('stop_http');
    await Promise.resolve();
  });
  const handle = registerGracefulShutdown({
    drain,
    markDraining,
    signals: [],
    stopHttp,
    ...overrides,
  });
  return { drain, handle, markDraining, order, stopHttp };
}

describe('graceful shutdown', () => {
  it('stops advertising readiness before it stops workers or HTTP', async () => {
    const { handle, order } = handleFor();

    await handle.shutdown('SIGTERM');

    // Readiness must go first so the load balancer drains this replica while it can still finish
    // what it already accepted.
    expect(order).toEqual(['mark_draining', 'drain', 'stop_http']);
  });

  it('runs the sequence exactly once no matter how many signals arrive', async () => {
    const { drain, handle, markDraining, stopHttp } = handleFor();

    await Promise.all([
      handle.shutdown('SIGTERM'),
      handle.shutdown('SIGTERM'),
      handle.shutdown('SIGINT'),
    ]);
    await handle.shutdown('SIGTERM');

    expect(markDraining).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(stopHttp).toHaveBeenCalledTimes(1);
  });

  it('reports that it is shutting down once a signal has been handled', async () => {
    const { handle } = handleFor();

    expect(handle.isShuttingDown()).toBe(false);
    const running = handle.shutdown('SIGTERM');
    expect(handle.isShuttingDown()).toBe(true);
    await running;
  });

  it('detaches its listeners so a second sequence can never be started later', async () => {
    const onComplete = vi.fn();
    const { handle } = handleFor({ onComplete });

    await handle.shutdown('SIGINT');

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('SIGINT');
  });

  it('ignores a second operating-system signal instead of duplicating cleanup', async () => {
    const info = vi.fn();
    const { drain, handle, markDraining } = handleFor({
      logger: { info, warn: vi.fn() },
      signals: ['SIGTERM'],
    });

    // Two real signals, exactly one shutdown sequence.
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    await handle.shutdown('SIGTERM');

    expect(markDraining).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(
      info.mock.calls.some(
        ([payload]) =>
          (payload as { operation?: unknown }).operation === 'runtime.shutdown_signal_ignored',
      ),
    ).toBe(true);
    handle.dispose();
  });

  it('runs the same sequence for SIGINT as for SIGTERM', async () => {
    const { handle, order } = handleFor();

    await handle.shutdown('SIGINT');

    expect(order).toEqual(['mark_draining', 'drain', 'stop_http']);
  });
});

describe('shutdown failure handling', () => {
  it('still closes HTTP when the worker drain rejects', async () => {
    // The defect this replaces: awaiting drain and stopHttp in one expression meant a rejected
    // drain skipped the HTTP close entirely and left the listener open on a wedged process.
    const warn = vi.fn();
    const error = vi.fn();
    const info = vi.fn();
    const previousExitCode = process.exitCode;
    const { handle, order, stopHttp } = handleFor({
      drain: () =>
        Promise.reject(
          Object.assign(new Error('worker teardown hit https://secret-db-host.example.internal'), {
            code: 'ECONNREFUSED',
          }),
        ),
      logger: { error, info, warn },
    });

    await expect(handle.shutdown('SIGTERM')).resolves.toBeUndefined();

    expect(stopHttp).toHaveBeenCalledTimes(1);
    expect(order).toContain('stop_http');
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;

    // Not a clean stop, and never the raw Error.
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).toContain('runtime.stopped_with_errors');
    // The clean-stop line is not written for a sequence that did not reach its terminal state.
    expect(
      info.mock.calls.some(
        ([payload]) => (payload as { operation?: unknown }).operation === 'runtime.stopped',
      ),
    ).toBe(false);
    expect(logged).not.toContain('secret-db-host');
    expect(logged).not.toContain('https://');
    expect(logged).toContain('database_unavailable');
  });

  it('closes HTTP even when the durable heartbeat stop rejects', async () => {
    const previousExitCode = process.exitCode;
    const stopHeartbeat = vi.fn(() => Promise.reject(new Error('stop_runtime_instance failed')));
    const { handle, order, stopHttp } = handleFor({
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      stopHeartbeat,
    });

    await handle.shutdown('SIGTERM');

    // Reporting is last and never blocks the two local steps.
    expect(order).toEqual(['mark_draining', 'drain', 'stop_http']);
    expect(stopHttp).toHaveBeenCalledTimes(1);
    expect(stopHeartbeat).toHaveBeenCalledTimes(1);
    process.exitCode = previousExitCode;
  });

  it('terminates through the injected exit seam when the window elapses', async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const warn = vi.fn();
    const info = vi.fn();
    const previousExitCode = process.exitCode;
    const drainControl: { release: () => void } = { release: () => {} };
    const { handle, stopHttp } = handleFor({
      // A hung provider socket: the promise never settles, so nothing after it can run.
      drain: () =>
        new Promise<void>((resolve) => {
          drainControl.release = resolve;
        }),
      forceExit,
      logger: { error: vi.fn(), info, warn },
      timeoutMs: 5_000,
    });

    const running = handle.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(forceExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);

    // Exactly once, and setting process.exitCode alone would never have terminated this process.
    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(1);
    expect(
      warn.mock.calls.some(
        ([payload]) =>
          (payload as { operation?: unknown }).operation === 'runtime.shutdown_timeout',
      ),
    ).toBe(true);

    // No new provider mutation is started by the timeout path, and the clean-stop line is not
    // written for a process that had to be killed.
    expect(stopHttp).not.toHaveBeenCalled();
    drainControl.release();
    await running;
    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(
      info.mock.calls.some(
        ([payload]) => (payload as { operation?: unknown }).operation === 'runtime.stopped',
      ),
    ).toBe(false);
    process.exitCode = previousExitCode;
    vi.useRealTimers();
  });
});
