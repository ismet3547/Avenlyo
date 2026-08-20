import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { RuntimeComponent } from './runtime-state.js';
import type { WorkerObserver, WorkerTickOutcome } from './worker-observer.js';

/**
 * Durable runtime heartbeats.
 *
 * Writes are bounded to one flush per interval per component, never one per queue item, so an
 * always-busy worker costs the same as an idle one. A heartbeat write failure is logged and retried
 * on the next interval rather than crashing the process or spinning: if the database is genuinely
 * gone, the readiness probe already reports that far more directly.
 */

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;

export type HeartbeatRpcClient = SupabaseClient<Database>;

export interface HeartbeatLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

type ComponentState = 'starting' | 'running' | 'stopping' | 'stopped';

interface ComponentRecord {
  errorCode: string | null;
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

  /** Registration is best effort: a database outage must not stop the process from booting. */
  public async register(): Promise<boolean> {
    const { error } = await this.input.client.rpc('register_runtime_instance', {
      target_instance_id: this.input.instanceId,
      target_release: this.input.release,
      target_service: this.input.service ?? 'avenlyo-api',
    });
    if (error) {
      this.warn('runtime.heartbeat.register_failed');
      this.registered = false;
      return false;
    }
    this.registered = true;
    return true;
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
      record.errorCode = outcome.errorCode.slice(0, 60);
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
    if (this.flushing) return this.flushing;
    this.flushing = this.writeAll();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async writeAll(): Promise<void> {
    if (!this.registered) {
      const recovered = await this.register();
      if (!recovered) return;
    }
    for (const [component, record] of this.components) {
      const { error } = await this.input.client.rpc('heartbeat_runtime_component', {
        target_component: component,
        target_error_code: record.errorCode,
        target_instance_id: this.input.instanceId,
        target_state: record.state,
        target_succeeded: record.pendingOutcome,
      });
      if (error) {
        // Leave the pending outcome in place so the next interval reports it instead of losing it.
        this.warn('runtime.heartbeat.write_failed');
        this.registered = false;
        return;
      }
      record.pendingOutcome = null;
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const [component] of this.components) this.recordState(component, 'stopped');
    await this.flush();
    if (!this.registered) return;
    const { error } = await this.input.client.rpc('stop_runtime_instance', {
      target_instance_id: this.input.instanceId,
    });
    if (error) this.warn('runtime.heartbeat.stop_failed');
  }

  private warn(operation: string): void {
    this.input.logger?.warn(
      { component: 'runtime_heartbeat', operation, outcome: 'failed' },
      'Runtime heartbeat write failed.',
    );
  }
}
