import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

import { classifyDatabaseError, toErrorCode, type ErrorCode } from './errors.js';
import type { RuntimeComponent } from './runtime-state.js';
import type { WorkerObserver, WorkerTickOutcome } from './worker-observer.js';

/**
 * Durable runtime heartbeats.
 *
 * Writes are bounded to one flush per interval, never one per queue item, so an always-busy worker
 * costs the same as an idle one. Every write is best effort: a failure is logged with a bounded code
 * and retried on the next interval rather than crashing the process or spinning. If the database is
 * genuinely gone the readiness probe reports that far more directly, and it, not this reporter, owns
 * database readiness truth.
 *
 * Nothing here may throw. This reporter runs from a timer and from shutdown, where an unhandled
 * rejection would kill a process that is otherwise perfectly able to serve traffic.
 */

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;

export type HeartbeatRpcClient = SupabaseClient<Database>;

export interface HeartbeatLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

type ComponentState = 'starting' | 'running' | 'stopping' | 'stopped';

interface ComponentRecord {
  errorCode: ErrorCode | null;
  pendingOutcome: boolean | null;
  state: ComponentState;
}

export interface RuntimeHeartbeatReporterInput {
  readonly client: HeartbeatRpcClient;
  readonly instanceId: string;
  readonly intervalMs?: number;
  readonly logger?: HeartbeatLogger;
  readonly release: string;
  readonly service?: string;
}

export class RuntimeHeartbeatReporter {
  private readonly components = new Map<RuntimeComponent, ComponentRecord>();
  private flushing: Promise<void> | null = null;
  private registered = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  public constructor(private readonly input: RuntimeHeartbeatReporterInput) {}

  private get intervalMs(): number {
    return this.input.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  /**
   * Registration is best effort and never rejects. A database that is unavailable at boot is
   * reported by readiness, not by refusing to start a process that may recover, and a transport
   * error thrown by the client must not become an unhandled rejection on the startup path.
   */
  public async register(): Promise<boolean> {
    const ok = await this.attempt('runtime.heartbeat.register_failed', () =>
      this.input.client.rpc('register_runtime_instance', {
        target_instance_id: this.input.instanceId,
        target_release: this.input.release,
        target_service: this.input.service ?? 'avenlyo-api',
      }),
    );
    this.registered = ok;
    return ok;
  }

  public observerFor(component: RuntimeComponent): WorkerObserver {
    return {
      onStart: () => this.recordState(component, 'running'),
      onStop: () => this.recordState(component, 'stopped'),
      onTick: (outcome: WorkerTickOutcome) => this.recordTick(component, outcome),
    };
  }

  public recordState(component: RuntimeComponent, state: ComponentState): void {
    const record = this.components.get(component) ?? {
      errorCode: null,
      pendingOutcome: null,
      state,
    };
    record.state = state;
    this.components.set(component, record);
  }

  private recordTick(component: RuntimeComponent, outcome: WorkerTickOutcome): void {
    const record = this.components.get(component) ?? {
      errorCode: null,
      pendingOutcome: null,
      state: 'running' as ComponentState,
    };
    // A failure inside the interval is what the operator needs to see, so it wins over a success.
    if (outcome.ok) {
      if (record.pendingOutcome !== false) {
        record.pendingOutcome = true;
        record.errorCode = null;
      }
    } else {
      record.pendingOutcome = false;
      // Membership of the approved code set, not length. Truncating free-form text would still
      // persist a phone number, a customer fragment, or a provider response if it happened to be
      // short, so an unapproved value is replaced rather than trimmed.
      record.errorCode = toErrorCode(outcome.errorCode);
    }
    this.components.set(component, record);
  }

  public start(): void {
    if (this.stopped || this.timer) return;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Exposed so tests and shutdown can force one bounded write without waiting for the interval. */
  public async flush(): Promise<void> {
    return this.flushWith(true);
  }

  private async flushWith(allowRegistration: boolean): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.writeAll(allowRegistration);
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async writeAll(allowRegistration: boolean): Promise<void> {
    if (!this.registered) {
      if (!allowRegistration) return;
      const recovered = await this.register();
      if (!recovered) return;
    }

    // Process liveness first, and independently of any component. The instance heartbeat used to
    // advance only as a side effect of a component write, so a core-only API deployment with zero
    // configured background workers looked silent after two intervals and was reported stale while
    // it was serving traffic perfectly. One bounded update per interval fixes that without
    // inventing fake components to keep a process visible.
    const alive = await this.attempt('runtime.heartbeat.instance_write_failed', () =>
      this.input.client.rpc('heartbeat_runtime_instance', {
        target_instance_id: this.input.instanceId,
      }),
    );
    if (!alive) {
      this.registered = false;
      return;
    }

    for (const [component, record] of this.components) {
      const written = await this.attempt('runtime.heartbeat.write_failed', () =>
        this.input.client.rpc('heartbeat_runtime_component', {
          target_component: component,
          target_error_code: record.errorCode,
          target_instance_id: this.input.instanceId,
          target_state: record.state,
          target_succeeded: record.pendingOutcome,
        }),
      );
      if (!written) {
        // Leave the pending outcome in place so the next interval reports it instead of losing it.
        this.registered = false;
        return;
      }
      record.pendingOutcome = null;
    }
  }

  /**
   * Records the deliberate stop. Never rejects and never blocks local shutdown: this is durable
   * operational reporting, and HTTP drain matters more than a heartbeat row.
   */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const [component] of this.components) this.recordState(component, 'stopped');

    // No registration during shutdown. register_runtime_instance clears stopped_at, so recovering a
    // lost registration here would resurrect the very instance being stopped.
    await this.flushWith(false);

    // Attempted unconditionally. A component write that failed a moment ago says nothing about
    // whether the database is reachable now, and leaving stopped_at null makes a clean shutdown
    // indistinguishable from a crash for the whole retention window. The RPC names this exact
    // instance and is idempotent, so an attempt that cannot succeed costs one no-op statement.
    await this.attempt('runtime.heartbeat.stop_failed', () =>
      this.input.client.rpc('stop_runtime_instance', {
        target_instance_id: this.input.instanceId,
      }),
    );
  }

  /**
   * Single boundary for every heartbeat RPC. It absorbs both failure shapes the client can produce,
   * a resolved result carrying an error and a rejected promise, so no call site can leak an
   * unhandled rejection, and it is the only place that logs.
   */
  private async attempt(
    operation: string,
    call: () => PromiseLike<{ readonly error: unknown }>,
  ): Promise<boolean> {
    try {
      const { error } = await call();
      if (!error) return true;
      this.warn(operation, classifyDatabaseError(error));
      return false;
    } catch (error) {
      this.warn(operation, classifyDatabaseError(error));
      return false;
    }
  }

  /**
   * Bounded fields only: component, operation, outcome, and an approved error code. Never the
   * database URL, the Supabase error text, a credential, a payload, or a stack trace.
   */
  private warn(operation: string, errorCode: ErrorCode): void {
    this.input.logger?.warn(
      {
        component: 'runtime_heartbeat',
        error_code: errorCode,
        operation,
        outcome: 'failed',
      },
      'Runtime heartbeat write failed.',
    );
  }
}
