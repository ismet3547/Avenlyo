import { randomUUID } from 'node:crypto';

/**
 * Per-process runtime state that readiness reads.
 *
 * The instance identifier is ephemeral and generated at process start. It is a correlation handle
 * only: it is never an authorization subject, and no host, container, or network identity is used,
 * because several replicas may run at once and durable claim and idempotency semantics — not
 * process identity — remain the authority for who may do work.
 */

export type RuntimeComponent =
  | 'message_processing'
  | 'appointment_reminders'
  | 'lead_followups'
  | 'billing_events'
  | 'knowledge_imports';

export const RUNTIME_COMPONENTS: readonly RuntimeComponent[] = [
  'appointment_reminders',
  'billing_events',
  'knowledge_imports',
  'lead_followups',
  'message_processing',
];

export class RuntimeState {
  private draining = false;
  private readonly failedSchedulers = new Set<RuntimeComponent>();
  private localStartupComplete = false;

  public constructor(public readonly instanceId: string = randomUUID()) {}

  public isDraining(): boolean {
    return this.draining;
  }

  /**
   * True once every locally owned startup step has finished: worker schedulers constructed and
   * started, or deliberately absent. Liveness is available before this point, because a process
   * that is listening is alive. Readiness is not, because a replica that has not yet started its
   * schedulers would accept traffic it cannot process.
   *
   * Durable heartbeat registration is deliberately not part of this: it is operational reporting
   * over the network, not a local prerequisite, and readiness already owns database truth
   * through its own probe.
   */
  public isLocalStartupComplete(): boolean {
    return this.localStartupComplete;
  }

  public markLocalStartupComplete(): void {
    this.localStartupComplete = true;
  }

  /** Called on the first shutdown signal so readiness stops advertising this replica immediately. */
  public markDraining(): void {
    this.draining = true;
  }

  /**
   * A configured worker loop that could not start is a dead component in a process that would
   * otherwise look healthy, so it must make this replica unready rather than silently degrade.
   */
  public registerSchedulerFailure(component: RuntimeComponent): void {
    this.failedSchedulers.add(component);
  }

  public clearSchedulerFailure(component: RuntimeComponent): void {
    this.failedSchedulers.delete(component);
  }

  public schedulerFailures(): readonly RuntimeComponent[] {
    return [...this.failedSchedulers].sort();
  }
}

export function createRuntimeState(instanceId?: string): RuntimeState {
  return instanceId ? new RuntimeState(instanceId) : new RuntimeState();
}
