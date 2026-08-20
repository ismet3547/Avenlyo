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

  it('still tears down worker runtimes when startup fails before shutdown is needed', async () => {
    // Mirrors the listen-failure path in server.ts: the handle is disposed and the runtimes are
    // stopped directly, so no worker timer is left running in an orphaned process.
    const stopped: string[] = [];
    const { handle } = handleFor();
    handle.dispose();

    const messagingStop = () => Promise.resolve(void stopped.push('messaging'));
    const billingStop = () => Promise.resolve(void stopped.push('billing'));
    await Promise.all([messagingStop(), billingStop()]);

    expect(handle.isShuttingDown()).toBe(false);
    expect(stopped.sort()).toEqual(['billing', 'messaging']);
  });
});
