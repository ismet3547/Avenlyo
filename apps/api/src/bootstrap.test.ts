import { describe, expect, it, vi } from 'vitest';

import {
  bootstrapRuntime,
  type BootstrapApp,
  type BootstrapHeartbeat,
  type BootstrapWorkerRuntime,
} from './bootstrap.js';
import { createRuntimeState, type RuntimeComponent } from './observability/runtime-state.js';
import type { WorkerObserver } from './observability/worker-observer.js';

/**
 * These exercise the real startup orchestration rather than re-implementing it. The previous test
 * called two fake stop functions and asserted they had been called, which proved nothing about the
 * sequence: it never built an app, never listened, and never touched the code being tested.
 *
 * Every external boundary is injected, so nothing here opens a port or reaches Supabase, OpenAI,
 * Twilio, Google, ezyVet, or Stripe.
 */

function fakeApp(input: { readonly listenFails?: boolean } = {}) {
  const events: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const record = (payload: Record<string, unknown>) => void logs.push(payload);
  const app: BootstrapApp = {
    close: () => Promise.resolve(void events.push('close')),
    listen: () => {
      events.push('listen');
      return input.listenFails ? Promise.reject(new Error('EADDRINUSE')) : Promise.resolve(null);
    },
    log: { error: record, info: record, warn: record },
  };
  return { app, events, logs };
}

function fakeWorkerRuntime(
  components: readonly RuntimeComponent[],
  input: { readonly startThrows?: boolean } = {},
) {
  const events: string[] = [];
  let timerRunning = false;
  const runtime: BootstrapWorkerRuntime = {
    components,
    start: () => {
      if (input.startThrows) throw new Error('scheduler could not start');
      timerRunning = true;
      events.push('start');
    },
    stop: () => {
      timerRunning = false;
      events.push('stop');
      return Promise.resolve();
    },
  };
  return { events, runtime, isTimerRunning: () => timerRunning };
}

/** Records every component event the reporter actually receives, in order. */
interface ComponentEvent {
  readonly component: RuntimeComponent;
  readonly detail?: string;
  readonly kind: 'start' | 'stop' | 'tick';
}

function fakeHeartbeat(input: { readonly register?: () => Promise<boolean> } = {}) {
  const events: string[] = [];
  const componentEvents: ComponentEvent[] = [];
  const heartbeat: BootstrapHeartbeat = {
    observerFor: (component) => ({
      onStart: () => void componentEvents.push({ component, kind: 'start' }),
      onStop: () => void componentEvents.push({ component, kind: 'stop' }),
      onTick: (outcome) =>
        void componentEvents.push({
          component,
          detail: outcome.ok ? 'ok' : outcome.errorCode,
          kind: 'tick',
        }),
    }),
    recordState: (component) => void events.push(`state:${component}`),
    register: input.register ?? (() => Promise.resolve(true)),
    start: () => void events.push('start'),
    stop: () => Promise.resolve(void events.push('stop')),
  };
  return { componentEvents, events, heartbeat };
}

describe('liveness before the database', () => {
  it('starts listening even when heartbeat registration never resolves', async () => {
    // A database that is unreachable at boot: the RPC hangs rather than failing fast. Awaiting it
    // before listen meant the process never served liveness at all, so an orchestrator killed a
    // container that was otherwise healthy.
    const app = fakeApp();
    const heartbeat = fakeHeartbeat({ register: () => new Promise<boolean>(() => {}) });
    const runtimeState = createRuntimeState();

    const result = await bootstrapRuntime({
      buildApp: () => app.app,
      createBillingRuntime: () => null,
      createHeartbeat: () => heartbeat.heartbeat,
      createMessagingRuntime: () => null,
      runtimeState,
    });

    expect(result.listening).toBe(true);
    expect(app.events).toContain('listen');
    // Registration is still pending, and the process is serving anyway.
    expect(heartbeat.events).not.toContain('start');
    expect(runtimeState.isLocalStartupComplete()).toBe(true);
  });

  it('starts listening when heartbeat registration rejects outright', async () => {
    const app = fakeApp();
    const heartbeat = fakeHeartbeat({
      register: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });

    const result = await bootstrapRuntime({
      buildApp: () => app.app,
      createBillingRuntime: () => null,
      createHeartbeat: () => heartbeat.heartbeat,
      createMessagingRuntime: () => null,
    });
    await result.heartbeatRegistration;

    // No unhandled rejection, the listener came up, and the bounded interval still starts so the
    // next heartbeat can retry.
    expect(result.listening).toBe(true);
    expect(heartbeat.events).toContain('start');
  });

  it('does not report ready before configured schedulers have been initialised', async () => {
    const app = fakeApp();
    const messaging = fakeWorkerRuntime(['message_processing']);
    const runtimeState = createRuntimeState();
    const readyDuringListen: boolean[] = [];

    await bootstrapRuntime({
      buildApp: () => ({
        ...app.app,
        listen: () => {
          // Readiness is only reachable once the listener exists, so this is the earliest moment a
          // load balancer could observe the process.
          readyDuringListen.push(runtimeState.isLocalStartupComplete());
          return Promise.resolve(null);
        },
      }),
      createBillingRuntime: () => null,
      createHeartbeat: () => null,
      createMessagingRuntime: () => messaging.runtime,
      runtimeState,
    });

    expect(messaging.events).toEqual(['start']);
    expect(readyDuringListen).toEqual([true]);
  });
});

describe('startup failure cleanup', () => {
  it('stops every started worker runtime and the reporter when listen fails', async () => {
    const app = fakeApp({ listenFails: true });
    const messaging = fakeWorkerRuntime(['message_processing', 'lead_followups']);
    const billing = fakeWorkerRuntime(['billing_events']);
    const heartbeat = fakeHeartbeat();
    const previousExitCode = process.exitCode;

    const result = await bootstrapRuntime({
      buildApp: () => app.app,
      createBillingRuntime: () => ({ ...billing.runtime, service: null as never }),
      createHeartbeat: () => heartbeat.heartbeat,
      createMessagingRuntime: () => messaging.runtime,
    });

    expect(result.listening).toBe(false);
    // No orphaned scheduler timer survives a process that cannot serve.
    expect(messaging.events).toEqual(['start', 'stop']);
    expect(billing.events).toEqual(['start', 'stop']);
    expect(messaging.isTimerRunning()).toBe(false);
    expect(billing.isTimerRunning()).toBe(false);
    expect(heartbeat.events).toContain('stop');
    expect(app.events).toContain('close');
    expect(result.runtimeState.isDraining()).toBe(true);
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });

  it('completes the rest of the cleanup when one teardown rejects', async () => {
    const app = fakeApp({ listenFails: true });
    const messaging = fakeWorkerRuntime(['message_processing']);
    const failing: BootstrapWorkerRuntime = {
      ...messaging.runtime,
      stop: () => Promise.reject(new Error('worker teardown failed')),
    };
    const heartbeat = fakeHeartbeat();
    const previousExitCode = process.exitCode;

    const result = await bootstrapRuntime({
      buildApp: () => app.app,
      createBillingRuntime: () => null,
      createHeartbeat: () => heartbeat.heartbeat,
      createMessagingRuntime: () => failing,
    });

    expect(result.listening).toBe(false);
    // A rejected worker stop must not skip the reporter stop or the HTTP close.
    expect(heartbeat.events).toContain('stop');
    expect(app.events).toContain('close');
    process.exitCode = previousExitCode;
  });

  it('registers a scheduler failure and keeps the process unready when a worker start throws', async () => {
    const app = fakeApp();
    const messaging = fakeWorkerRuntime(['message_processing', 'lead_followups'], {
      startThrows: true,
    });
    const runtimeState = createRuntimeState();

    const result = await bootstrapRuntime({
      buildApp: () => app.app,
      createBillingRuntime: () => null,
      createHeartbeat: () => null,
      createMessagingRuntime: () => messaging.runtime,
      runtimeState,
    });

    // The listener still comes up -- the process is alive -- but readiness now has a reason to
    // refuse, because a configured worker loop is dead.
    expect(result.listening).toBe(true);
    expect(runtimeState.schedulerFailures()).toEqual(['lead_followups', 'message_processing']);
  });
});

describe('shutdown wiring', () => {
  it('drains workers, closes HTTP, and records the stop through the registered handle', async () => {
    const app = fakeApp();
    const messaging = fakeWorkerRuntime(['message_processing']);
    const heartbeat = fakeHeartbeat();
    const forceExit = vi.fn();

    const result = await bootstrapRuntime({
      buildApp: () => app.app,
      createBillingRuntime: () => null,
      createHeartbeat: () => heartbeat.heartbeat,
      createMessagingRuntime: () => messaging.runtime,
      forceExit,
    });
    await result.shutdown?.shutdown('SIGTERM');

    expect(result.runtimeState.isDraining()).toBe(true);
    expect(messaging.events).toEqual(['start', 'stop']);
    expect(app.events).toEqual(['listen', 'close']);
    expect(heartbeat.events).toContain('stop');
    // The bounded window never elapsed, so the escape hatch was never needed.
    expect(forceExit).not.toHaveBeenCalled();
  });
});

/**
 * Reproduces the exact production construction order rather than a convenient one.
 *
 * A runtime factory resolves `observerFor(component)` while it builds its workers and stores the
 * returned object in a field. That happens before the reporter can exist, because the reporter
 * needs the app logger, the app needs the billing service, and the billing service comes out of
 * this very factory. A fake that ignores `observerFor`, or that calls it later, would pass against
 * an implementation that hands every worker a permanently dead observer.
 */
function observerCapturingRuntime(
  components: readonly RuntimeComponent[],
  input: { readonly observerFor: (component: RuntimeComponent) => WorkerObserver },
) {
  // Resolved now, at construction, exactly as the real factories do.
  const stored = new Map<RuntimeComponent, WorkerObserver>();
  for (const component of components) stored.set(component, input.observerFor(component));

  const runtime: BootstrapWorkerRuntime = {
    components,
    start: () => {
      for (const component of components) stored.get(component)?.onStart();
    },
    stop: () => {
      for (const component of components) stored.get(component)?.onStop();
      return Promise.resolve();
    },
  };
  return { runtime, stored };
}

describe('worker observer wiring', () => {
  it('delivers worker events to a reporter created after the workers were built', async () => {
    const app = fakeApp();
    const heartbeat = fakeHeartbeat();
    let messaging: ReturnType<typeof observerCapturingRuntime> | null = null;

    const result = await bootstrapRuntime({
      buildApp: () => app.app,
      createBillingRuntime: () => null,
      // Created after the runtimes, which is the ordering that broke this.
      createHeartbeat: () => heartbeat.heartbeat,
      createMessagingRuntime: (options) => {
        messaging = observerCapturingRuntime(['message_processing'], options);
        return messaging.runtime;
      },
    });

    // The worker is running: a tick happens, then the process shuts down.
    const observer = messaging!.stored.get('message_processing');
    observer?.onTick({ ok: true });
    await result.shutdown?.shutdown('SIGTERM');

    expect(heartbeat.componentEvents).toEqual([
      { component: 'message_processing', kind: 'start' },
      { component: 'message_processing', detail: 'ok', kind: 'tick' },
      { component: 'message_processing', kind: 'stop' },
    ]);
  });

  it('hands out one stable observer per component so a worker can store it', async () => {
    const app = fakeApp();
    const heartbeat = fakeHeartbeat();
    const handedOut: WorkerObserver[] = [];

    await bootstrapRuntime({
      buildApp: () => app.app,
      createBillingRuntime: () => null,
      createHeartbeat: () => heartbeat.heartbeat,
      createMessagingRuntime: (options) => {
        handedOut.push(options.observerFor('message_processing'));
        handedOut.push(options.observerFor('message_processing'));
        return null;
      },
    });

    // Identity matters: a worker keeps the object it was given, so re-asking must not produce a
    // second observer that a later event could be routed through instead.
    expect(handedOut[0]).toBe(handedOut[1]);

    // And the object handed out first is a live route, not a dead one.
    handedOut[0]?.onTick({ ok: true });
    expect(heartbeat.componentEvents).toEqual([
      { component: 'message_processing', detail: 'ok', kind: 'tick' },
    ]);
  });

  it('scopes each component to its own observer with no cross-mixing', async () => {
    const app = fakeApp();
    const heartbeat = fakeHeartbeat();
    let messaging: ReturnType<typeof observerCapturingRuntime> | null = null;
    let billing: ReturnType<typeof observerCapturingRuntime> | null = null;

    await bootstrapRuntime({
      buildApp: () => app.app,
      createBillingRuntime: (options) => {
        billing = observerCapturingRuntime(['billing_events'], options);
        return { ...billing.runtime, service: null as never };
      },
      createHeartbeat: () => heartbeat.heartbeat,
      createMessagingRuntime: (options) => {
        messaging = observerCapturingRuntime(
          ['message_processing', 'appointment_reminders', 'lead_followups'],
          options,
        );
        return messaging.runtime;
      },
    });

    // Every configured component reported its own start, and nothing was invented for a
    // runtime that does not exist.
    expect(heartbeat.componentEvents.filter((event) => event.kind === 'start')).toEqual([
      { component: 'message_processing', kind: 'start' },
      { component: 'appointment_reminders', kind: 'start' },
      { component: 'lead_followups', kind: 'start' },
      { component: 'billing_events', kind: 'start' },
    ]);

    heartbeat.componentEvents.length = 0;
    messaging!.stored.get('message_processing')?.onTick({ ok: true });
    billing!.stored.get('billing_events')?.onTick({ errorCode: 'provider_timeout', ok: false });

    // No cross-component mixing: each event carries the component it was scoped to.
    expect(heartbeat.componentEvents).toEqual([
      { component: 'message_processing', detail: 'ok', kind: 'tick' },
      { component: 'billing_events', detail: 'provider_timeout', kind: 'tick' },
    ]);
  });

  it('stays a safe no-op when no heartbeat reporter exists at all', async () => {
    // A deployment without the trusted backend has no reporter, and workers must not care.
    const app = fakeApp();
    let messaging: ReturnType<typeof observerCapturingRuntime> | null = null;

    const result = await bootstrapRuntime({
      buildApp: () => app.app,
      createBillingRuntime: () => null,
      createHeartbeat: () => null,
      createMessagingRuntime: (options) => {
        messaging = observerCapturingRuntime(['message_processing'], options);
        return messaging.runtime;
      },
    });

    expect(result.listening).toBe(true);
    expect(() => {
      messaging!.stored.get('message_processing')?.onTick({ ok: true });
      messaging!.stored.get('message_processing')?.onStop();
    }).not.toThrow();
  });

  it('reports no start for a component whose scheduler threw', async () => {
    const app = fakeApp();
    const heartbeat = fakeHeartbeat();
    const runtimeState = createRuntimeState();

    await bootstrapRuntime({
      buildApp: () => app.app,
      createBillingRuntime: () => null,
      createHeartbeat: () => heartbeat.heartbeat,
      createMessagingRuntime: (options) => {
        void options.observerFor('message_processing');
        return {
          components: ['message_processing'],
          start: () => {
            throw new Error('scheduler could not start');
          },
          stop: () => Promise.resolve(),
        };
      },
      runtimeState,
    });

    // A dead scheduler must not look like a running component.
    expect(heartbeat.componentEvents).toEqual([]);
    expect(runtimeState.schedulerFailures()).toEqual(['message_processing']);
  });
});
