/**
 * Graceful shutdown.
 *
 * The sequence matters: this replica stops advertising readiness first, so the load balancer takes
 * it out of rotation while it is still able to finish what it already accepted. Only then do worker
 * loops stop claiming, in-flight work is awaited, and HTTP is drained. Nothing here initiates a new
 * provider call, and no cleanup runs twice, so a shutdown can never duplicate a provider mutation.
 */

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

export interface ShutdownLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface GracefulShutdownInput {
  /** Stops worker scheduling and awaits in-flight ticks. */
  readonly drain: () => Promise<void>;
  readonly logger?: ShutdownLogger;
  /** Marks the process not-ready before anything is torn down. */
  readonly markDraining: () => void;
  readonly onComplete?: (signal: ShutdownSignal) => void;
  readonly signals?: readonly ShutdownSignal[];
  /** Closes the HTTP server after workers stop claiming. */
  readonly stopHttp: () => Promise<void>;
  readonly timeoutMs?: number;
}

export interface GracefulShutdownHandle {
  /** True once a signal has started the sequence. */
  isShuttingDown(): boolean;
  /** Detaches signal listeners; used by tests and by embedded hosts. */
  dispose(): void;
  /** Runs the sequence directly. Safe to call repeatedly: later calls await the first one. */
  shutdown(signal: ShutdownSignal): Promise<void>;
}

export function registerGracefulShutdown(input: GracefulShutdownInput): GracefulShutdownHandle {
  const signals = input.signals ?? (['SIGTERM', 'SIGINT'] as const);
  const timeoutMs = input.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let running: Promise<void> | null = null;
  const listeners = new Map<ShutdownSignal, () => void>();

  const dispose = (): void => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
    listeners.clear();
  };

  const run = async (signal: ShutdownSignal): Promise<void> => {
    input.markDraining();
    input.logger?.info(
      { component: 'runtime', operation: 'runtime.draining', signal },
      'Runtime draining.',
    );
    // A bounded escape hatch only. It never runs cleanup a second time; it exists so a wedged
    // in-flight operation cannot hold the process open forever.
    const guard = setTimeout(() => {
      input.logger?.warn(
        { component: 'runtime', operation: 'runtime.shutdown_timeout', outcome: 'forced' },
        'Shutdown exceeded its bounded window.',
      );
      process.exitCode = 1;
    }, timeoutMs);
    guard.unref?.();
    try {
      await input.drain();
      await input.stopHttp();
    } finally {
      clearTimeout(guard);
      dispose();
      input.logger?.info(
        { component: 'runtime', operation: 'runtime.stopped', signal },
        'Runtime stopped.',
      );
      input.onComplete?.(signal);
    }
  };

  const shutdown = (signal: ShutdownSignal): Promise<void> => {
    // A second signal joins the first sequence instead of starting another one.
    running ??= run(signal);
    return running;
  };

  for (const signal of signals) {
    const listener = (): void => {
      if (running) {
        input.logger?.info(
          { component: 'runtime', operation: 'runtime.shutdown_signal_ignored', signal },
          'Shutdown already in progress.',
        );
        return;
      }
      void shutdown(signal);
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }

  return {
    dispose,
    isShuttingDown: () => running !== null,
    shutdown,
  };
}
