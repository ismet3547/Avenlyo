import { classifyDatabaseError, type ErrorCode } from '../observability/errors.js';

/**
 * Graceful shutdown.
 *
 * The sequence matters: this replica stops advertising readiness first, so the load balancer takes
 * it out of rotation while it is still able to finish what it already accepted. Only then do worker
 * loops stop claiming, in-flight work is awaited, and HTTP is drained. Nothing here initiates a new
 * provider call, and no cleanup runs twice, so a shutdown can never duplicate a provider mutation.
 *
 * Two properties are load bearing and were previously only apparent:
 *
 * Every cleanup step runs. Awaiting drain and then HTTP close in one try block meant a rejected
 * drain skipped the HTTP close entirely, so a failed worker or heartbeat teardown left the listener
 * open and the process wedged. Each step is now attempted independently, in a fixed order, and a
 * failure is recorded as a bounded code rather than short-circuiting the rest.
 *
 * The timeout actually terminates. Setting `process.exitCode` asks Node to exit once the event loop
 * empties, which is exactly the thing a hung provider socket prevents. Termination goes through an
 * injectable `forceExit` so production really exits and tests can assert the call without killing
 * the test runner.
 */

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

export interface ShutdownLogger {
  error?(payload: Record<string, unknown>, message: string): void;
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface GracefulShutdownInput {
  /** Stops worker scheduling and awaits in-flight ticks. */
  readonly drain: () => Promise<void>;
  /**
   * Terminates a process the bounded window could not drain. Production passes `process.exit`;
   * tests pass a spy, so a unit test can prove the escape hatch fires without dying.
   */
  readonly forceExit?: (code: number) => void;
  readonly logger?: ShutdownLogger;
  /** Marks the process not-ready before anything is torn down. */
  readonly markDraining: () => void;
  readonly onComplete?: (signal: ShutdownSignal) => void;
  readonly signals?: readonly ShutdownSignal[];
  /** Closes the HTTP server after workers stop claiming. */
  readonly stopHttp: () => Promise<void>;
  /** Best-effort durable stop record. A failure here must never hold up HTTP close. */
  readonly stopHeartbeat?: () => Promise<void>;
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

/** Fixed step names so a failed shutdown is diagnosable from bounded log fields alone. */
type ShutdownStep = 'drain' | 'stop_http' | 'stop_heartbeat';

interface StepFailure {
  readonly errorCode: ErrorCode;
  readonly step: ShutdownStep;
}

export function registerGracefulShutdown(input: GracefulShutdownInput): GracefulShutdownHandle {
  const signals = input.signals ?? (['SIGTERM', 'SIGINT'] as const);
  const timeoutMs = input.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const forceExit = input.forceExit ?? ((code: number) => process.exit(code));
  let running: Promise<void> | null = null;
  let terminated = false;
  const listeners = new Map<ShutdownSignal, () => void>();

  const dispose = (): void => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
    listeners.clear();
  };

  /**
   * Runs one cleanup step and converts any failure into a bounded code. Raw Error objects are never
   * serialised: a rejected Supabase or provider teardown carries hostnames and response fragments in
   * its message, and shutdown is not a reason to start leaking them.
   */
  const attempt = async (
    step: ShutdownStep,
    action: () => Promise<void>,
  ): Promise<StepFailure | null> => {
    try {
      await action();
      return null;
    } catch (error) {
      const errorCode = classifyDatabaseError(error);
      input.logger?.warn(
        {
          component: 'runtime',
          error_code: errorCode,
          operation: 'runtime.shutdown_step_failed',
          outcome: 'failed',
          step,
        },
        'Shutdown step failed.',
      );
      return { errorCode, step };
    }
  };

  const run = async (signal: ShutdownSignal): Promise<void> => {
    input.markDraining();
    input.logger?.info(
      { component: 'runtime', operation: 'runtime.draining', signal },
      'Runtime draining.',
    );

    // A bounded escape hatch only. It never runs cleanup a second time; it exists so a wedged
    // in-flight operation cannot hold the process open forever. Once it fires the local sequence is
    // no longer the thing deciding the outcome, so it is reported with its own distinct outcome
    // rather than as a clean stop.
    const guard = setTimeout(() => {
      if (terminated) return;
      terminated = true;
      input.logger?.warn(
        { component: 'runtime', operation: 'runtime.shutdown_timeout', outcome: 'forced', signal },
        'Shutdown exceeded its bounded window; terminating.',
      );
      dispose();
      process.exitCode = 1;
      forceExit(1);
    }, timeoutMs);
    guard.unref?.();

    const failures: StepFailure[] = [];
    try {
      // Fixed order, every step attempted. Worker drain first so nothing new is claimed, then HTTP
      // so accepted requests finish, then the durable stop record, which is pure reporting and is
      // therefore last and never allowed to block the two local steps.
      const drainFailure = await attempt('drain', input.drain);
      if (drainFailure) failures.push(drainFailure);

      const httpFailure = await attempt('stop_http', input.stopHttp);
      if (httpFailure) failures.push(httpFailure);

      if (input.stopHeartbeat) {
        const heartbeatFailure = await attempt('stop_heartbeat', input.stopHeartbeat);
        if (heartbeatFailure) failures.push(heartbeatFailure);
      }
    } finally {
      clearTimeout(guard);
      // The forced path already terminated and already reported its own outcome; anything logged
      // here would claim a clean stop that did not happen.
      if (!terminated) {
        dispose();
        if (failures.length > 0) {
          // Not `runtime.stopped`: the sequence never reached its terminal clean state. Exit status
          // reflects that, while cleanup still ran to completion.
          process.exitCode = 1;
          const payload = {
            component: 'runtime',
            failed_steps: failures.map((failure) => failure.step),
            operation: 'runtime.stopped_with_errors',
            outcome: 'failed',
            signal,
          };
          const message = 'Runtime stopped after a failed cleanup step.';
          // error is optional on the logger contract, so warn is the guaranteed fallback.
          if (input.logger?.error) input.logger.error(payload, message);
          else input.logger?.warn(payload, message);
        } else {
          input.logger?.info(
            { component: 'runtime', operation: 'runtime.stopped', outcome: 'completed', signal },
            'Runtime stopped.',
          );
        }
        input.onComplete?.(signal);
      }
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
