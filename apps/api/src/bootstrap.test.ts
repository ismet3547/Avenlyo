import { describe, expect, it, vi } from 'vitest';

import {
  bootstrapRuntime,
  type BootstrapApp,
  type BootstrapHeartbeat,
  type BootstrapWorkerRuntime,
} from './bootstrap.js';
import { createRuntimeState, type RuntimeComponent } from './observability/runtime-state.js';

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

function fakeHeartbeat(input: { readonly register?: () => Promise<boolean> } = {}) {
  const events: string[] = [];
  const heartbeat: BootstrapHeartbeat = {
    observerFor: () => ({ onStart: () => {}, onStop: () => {}, onTick: () => {} }),
    recordState: (component) => void events.push(`state:${component}`),
    register: input.register ?? (() => Promise.resolve(true)),
    start: () => void events.push('start'),
    stop: () => Promise.resolve(void events.push('stop')),
  };
  return { events, heartbeat };
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
