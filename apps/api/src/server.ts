import { env, release } from './env.js';
import { buildApp } from './app.js';
import { createServiceSupabaseClient } from './lib/supabase.js';
import { registerGracefulShutdown } from './lib/shutdown.js';
import { RuntimeHeartbeatReporter } from './observability/heartbeat.js';
import { createRuntimeState, type RuntimeComponent } from './observability/runtime-state.js';
import { NOOP_WORKER_OBSERVER, type WorkerObserver } from './observability/worker-observer.js';
import { createBillingRuntime } from './services/billing/runtime.js';
import { createMessagingRuntime } from './services/messaging/runtime.js';

const runtimeState = createRuntimeState();
const supabase = createServiceSupabaseClient();

// Heartbeats are durable only when this process has the trusted backend boundary. Without it the
// workers do not exist either, so there is nothing to report.
const heartbeat = supabase
  ? new RuntimeHeartbeatReporter({
      client: supabase,
      instanceId: runtimeState.instanceId,
      release,
    })
  : null;

const observerFor = (component: RuntimeComponent): WorkerObserver =>
  heartbeat?.observerFor(component) ?? NOOP_WORKER_OBSERVER;

const messaging = createMessagingRuntime({ observerFor });
const billing = createBillingRuntime({ observerFor });
const app = buildApp({ billingService: billing?.service ?? null, runtimeState });

app.log.info(
  { component: 'runtime', instance_id: runtimeState.instanceId, operation: 'runtime.starting' },
  'Runtime starting.',
);

if (heartbeat) {
  // Best effort: a database that is unavailable at boot is reported by readiness, not by refusing
  // to start a process that may recover.
  await heartbeat.register();
  for (const component of [...(messaging?.components ?? []), ...(billing?.components ?? [])]) {
    heartbeat.recordState(component, 'starting');
  }
  heartbeat.start();
}

/** A configured worker loop that cannot start makes this replica unready rather than silently dead. */
function startRuntime(
  name: string,
  components: readonly RuntimeComponent[],
  start: () => void,
): void {
  try {
    start();
    for (const component of components) {
      runtimeState.clearSchedulerFailure(component);
      app.log.info({ component, operation: 'component.started' }, 'Runtime component started.');
    }
  } catch (error) {
    for (const component of components) runtimeState.registerSchedulerFailure(component);
    app.log.error(
      { component: name, operation: 'component.start_failed', outcome: 'failed' },
      'Runtime component failed to start.',
    );
    void error;
  }
}

if (messaging) startRuntime('messaging', messaging.components, () => messaging.start());
if (billing) startRuntime('billing', billing.components, () => billing.start());

const shutdown = registerGracefulShutdown({
  drain: async () => {
    await Promise.all([messaging?.stop(), billing?.stop()]);
    for (const component of [...(messaging?.components ?? []), ...(billing?.components ?? [])]) {
      app.log.info({ component, operation: 'component.stopped' }, 'Runtime component stopped.');
    }
    if (heartbeat) await heartbeat.stop();
  },
  logger: app.log,
  markDraining: () => runtimeState.markDraining(),
  stopHttp: () => app.close(),
});

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.log.info(
    { component: 'runtime', instance_id: runtimeState.instanceId, operation: 'runtime.ready' },
    'Runtime ready.',
  );
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
  await Promise.all([messaging?.stop(), billing?.stop()]);
  if (heartbeat) await heartbeat.stop();
  await app.close();
}
