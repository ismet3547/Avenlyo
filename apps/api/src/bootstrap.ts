import { buildApp as buildAppDefault } from './app.js';
import { env, release } from './env.js';
import { registerGracefulShutdown, type GracefulShutdownHandle } from './lib/shutdown.js';
import { createServiceSupabaseClient } from './lib/supabase.js';
import { RuntimeHeartbeatReporter } from './observability/heartbeat.js';
import {
  createRuntimeState,
  type RuntimeComponent,
  type RuntimeState,
} from './observability/runtime-state.js';
import { NOOP_WORKER_OBSERVER, type WorkerObserver } from './observability/worker-observer.js';
import type { BillingService } from './services/billing/billing-service.js';
import { createBillingRuntime as createBillingRuntimeDefault } from './services/billing/runtime.js';
import { createMessagingRuntime as createMessagingRuntimeDefault } from './services/messaging/runtime.js';

/**
 * Runtime bootstrap.
 *
 * Split out of `server.ts` so the startup sequence is an ordinary function with injectable
 * dependencies. As a top-level-await script it could not be tested at all: proving that a database
 * outage at boot still yields a live process, or that a failed listen stops every scheduler it
 * started, required starting a real process against real providers.
 *
 * The ordering rule is the important part. Liveness answers "is this process running", so nothing on
 * the path to `listen` may wait on Supabase, OpenAI, Twilio, Google, ezyVet, or Stripe. Heartbeat
 * registration is durable operational reporting, not a precondition for existing, so it runs
 * detached and bounded after the listener is up. Readiness stays false until local startup finishes,
 * which is what keeps the earlier listener from advertising a replica whose schedulers do not exist
 * yet.
 */

/** The part of a Fastify instance this module uses. Keeps the seam testable without a real server. */
export interface BootstrapApp {
  close(): Promise<void>;
  listen(options: { readonly host: string; readonly port: number }): Promise<unknown>;
  readonly log: {
    error(payload: Record<string, unknown>, message: string): void;
    info(payload: Record<string, unknown>, message: string): void;
    warn(payload: Record<string, unknown>, message: string): void;
  };
}

export interface BootstrapWorkerRuntime {
  readonly components: readonly RuntimeComponent[];
  start(): void;
  stop(): Promise<void>;
}

export interface BootstrapHeartbeat {
  observerFor(component: RuntimeComponent): WorkerObserver;
  recordState(component: RuntimeComponent, state: 'starting'): void;
  register(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}

export interface RuntimeBootstrapInput {
  readonly buildApp?: (input: {
    readonly billingService: BillingService | null;
    readonly runtimeState: RuntimeState;
  }) => BootstrapApp;
  readonly createBillingRuntime?: (input: {
    readonly observerFor: (component: RuntimeComponent) => WorkerObserver;
  }) => (BootstrapWorkerRuntime & { readonly service: BillingService }) | null;
  readonly createHeartbeat?: (input: {
    readonly instanceId: string;
    readonly logger: BootstrapApp['log'];
  }) => BootstrapHeartbeat | null;
  readonly createMessagingRuntime?: (input: {
    readonly observerFor: (component: RuntimeComponent) => WorkerObserver;
  }) => BootstrapWorkerRuntime | null;
  /** Passed straight through to the shutdown handler so tests never terminate the runner. */
  readonly forceExit?: (code: number) => void;
  readonly host?: string;
  readonly port?: number;
  readonly runtimeState?: RuntimeState;
  readonly shutdownTimeoutMs?: number;
}

export interface RuntimeBootstrapResult {
  readonly app: BootstrapApp;
  /** Resolves once detached heartbeat registration settles. Tests await it; production does not. */
  readonly heartbeatRegistration: Promise<void>;
  readonly listening: boolean;
  readonly runtimeState: RuntimeState;
  readonly shutdown: GracefulShutdownHandle | null;
}

function defaultHeartbeat(input: {
  readonly instanceId: string;
  readonly logger: BootstrapApp['log'];
}): BootstrapHeartbeat | null {
  // Heartbeats are durable only when this process has the trusted backend boundary. Without it the
  // workers do not exist either, so there is nothing to report. Constructing the client performs no
  // network call.
  const supabase = createServiceSupabaseClient();
  if (!supabase) return null;
  return new RuntimeHeartbeatReporter({
    client: supabase,
    instanceId: input.instanceId,
    // The production Pino logger, so a heartbeat failure is visible in the same structured stream as
    // everything else. Only bounded fields are ever passed to it.
    logger: input.logger,
    release,
  });
}

export async function bootstrapRuntime(
  input: RuntimeBootstrapInput = {},
): Promise<RuntimeBootstrapResult> {
  const runtimeState = input.runtimeState ?? createRuntimeState();
  const buildAppFn = input.buildApp ?? ((options) => buildAppDefault(options));
  const createMessaging = input.createMessagingRuntime ?? createMessagingRuntimeDefault;
  const createBilling = input.createBillingRuntime ?? createBillingRuntimeDefault;

  // Constructed first so its observers exist before any worker is built, but nothing is sent yet.
  let heartbeat: BootstrapHeartbeat | null = null;
  const observerFor = (component: RuntimeComponent): WorkerObserver =>
    heartbeat?.observerFor(component) ?? NOOP_WORKER_OBSERVER;

  const messaging = createMessaging({ observerFor });
  const billing = createBilling({ observerFor });
  const app = buildAppFn({ billingService: billing?.service ?? null, runtimeState });

  const createHeartbeatFn = input.createHeartbeat ?? defaultHeartbeat;
  heartbeat = createHeartbeatFn({ instanceId: runtimeState.instanceId, logger: app.log });

  app.log.info(
    { component: 'runtime', instance_id: runtimeState.instanceId, operation: 'runtime.starting' },
    'Runtime starting.',
  );

  const components = [...(messaging?.components ?? []), ...(billing?.components ?? [])];
  for (const component of components) heartbeat?.recordState(component, 'starting');

  /** A configured worker loop that cannot start makes this replica unready rather than silently dead. */
  const startWorkerRuntime = (
    name: string,
    runtimeComponents: readonly RuntimeComponent[],
    start: () => void,
  ): void => {
    try {
      start();
      for (const component of runtimeComponents) {
        runtimeState.clearSchedulerFailure(component);
        app.log.info({ component, operation: 'component.started' }, 'Runtime component started.');
      }
    } catch (error) {
      for (const component of runtimeComponents) runtimeState.registerSchedulerFailure(component);
      app.log.error(
        { component: name, operation: 'component.start_failed', outcome: 'failed' },
        'Runtime component failed to start.',
      );
      void error;
    }
  };

  // Scheduler startup is local and synchronous, and it happens before the listener exists, so there
  // is never a moment where readiness could report ready while a configured scheduler is missing.
  if (messaging) startWorkerRuntime('messaging', messaging.components, () => messaging.start());
  if (billing) startWorkerRuntime('billing', billing.components, () => billing.start());
  runtimeState.markLocalStartupComplete();

  const stopWorkerRuntimes = async (): Promise<void> => {
    await Promise.all([messaging?.stop(), billing?.stop()]);
    for (const component of components) {
      app.log.info({ component, operation: 'component.stopped' }, 'Runtime component stopped.');
    }
  };

  // Bound once so the shutdown wiring below never has to re-narrow the nullable field.
  const reporter = heartbeat;

  const shutdown = registerGracefulShutdown({
    drain: stopWorkerRuntimes,
    ...(input.forceExit ? { forceExit: input.forceExit } : {}),
    logger: app.log,
    markDraining: () => runtimeState.markDraining(),
    // Separate from drain so a failed worker teardown cannot skip the durable stop record, and a
    // failed stop record cannot hold up the HTTP close that precedes it.
    ...(reporter ? { stopHeartbeat: () => reporter.stop() } : {}),
    stopHttp: () => app.close(),
    ...(input.shutdownTimeoutMs !== undefined ? { timeoutMs: input.shutdownTimeoutMs } : {}),
  });

  // Detached on purpose. Awaiting registration here is what made a database outage at boot able to
  // stop the process from ever serving liveness: the RPC would hang or reject before `listen` was
  // reached. A failure is logged inside the reporter, the process stays alive, the next bounded
  // interval retries, and readiness keeps owning database truth through its own probe.
  const heartbeatRegistration = heartbeat
    ? Promise.resolve(heartbeat.register()).then(
        () => {
          heartbeat?.start();
        },
        () => {
          // The reporter already absorbs its own failures; this is a belt-and-braces guard so a
          // detached promise can never become an unhandled rejection.
          heartbeat?.start();
        },
      )
    : Promise.resolve();
  void heartbeatRegistration;

  try {
    await app.listen({ host: input.host ?? env.API_HOST, port: input.port ?? env.API_PORT });
    app.log.info(
      { component: 'runtime', instance_id: runtimeState.instanceId, operation: 'runtime.ready' },
      'Runtime ready.',
    );
    return { app, heartbeatRegistration, listening: true, runtimeState, shutdown };
  } catch (error) {
    // A failed listen must still stop worker timers, otherwise the process lingers with live loops.
    app.log.error(
      { component: 'runtime', operation: 'runtime.listen_failed', outcome: 'failed' },
      'Runtime failed to listen.',
    );
    void error;
    process.exitCode = 1;
    shutdown.dispose();
    runtimeState.markDraining();
    // Best effort and independent: one failing teardown must not leave the others undone.
    await Promise.allSettled([
      stopWorkerRuntimes(),
      heartbeat ? heartbeat.stop() : Promise.resolve(),
      app.close(),
    ]);
    return { app, heartbeatRegistration, listening: false, runtimeState, shutdown: null };
  }
}
