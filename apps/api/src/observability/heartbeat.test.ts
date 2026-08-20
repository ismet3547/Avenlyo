import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { RuntimeHeartbeatReporter } from './heartbeat.js';
import type { WorkerTickOutcome } from './worker-observer.js';

interface RpcCall {
  readonly args: Record<string, unknown>;
  readonly name: string;
}

function reporterFor(input: { readonly failWrites?: boolean; readonly instanceId?: string } = {}) {
  const calls: RpcCall[] = [];
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    calls.push({ args, name });
    const failing = input.failWrites && name === 'heartbeat_runtime_component';
    return Promise.resolve({ error: failing ? { message: 'unavailable' } : null });
  });
  const reporter = new RuntimeHeartbeatReporter({
    client: { rpc } as unknown as SupabaseClient<Database>,
    instanceId: input.instanceId ?? '11111111-1111-4111-8111-111111111111',
    release: 'abc123',
  });
  return { calls, reporter, rpc };
}

function heartbeatCalls(calls: readonly RpcCall[]): readonly RpcCall[] {
  return calls.filter((call) => call.name === 'heartbeat_runtime_component');
}

describe('runtime heartbeat reporter', () => {
  it('registers the instance with its release before reporting components', async () => {
    const { calls, reporter } = reporterFor();

    await reporter.register();

    expect(calls[0]).toMatchObject({
      args: { target_release: 'abc123', target_service: 'avenlyo-api' },
      name: 'register_runtime_instance',
    });
  });

  it('treats a tick that found no work as a successful tick', async () => {
    const { calls, reporter } = reporterFor();
    await reporter.register();

    reporter.observerFor('message_processing').onStart();
    reporter.observerFor('message_processing').onTick({ ok: true });
    await reporter.flush();

    expect(heartbeatCalls(calls)[0]?.args).toMatchObject({
      target_component: 'message_processing',
      target_state: 'running',
      target_succeeded: true,
    });
  });

  it('reports a bounded error code for a failed tick and clears it on the next success', async () => {
    const { calls, reporter } = reporterFor();
    await reporter.register();
    const observer = reporter.observerFor('billing_events');

    observer.onStart();
    observer.onTick({ errorCode: 'provider_timeout', ok: false });
    await reporter.flush();
    observer.onTick({ ok: true });
    await reporter.flush();

    const writes = heartbeatCalls(calls);
    expect(writes[0]?.args).toMatchObject({
      target_error_code: 'provider_timeout',
      target_succeeded: false,
    });
    expect(writes[1]?.args).toMatchObject({ target_error_code: null, target_succeeded: true });
  });

  it('reports a failure inside the interval even when a success also happened', async () => {
    const { calls, reporter } = reporterFor();
    await reporter.register();
    const observer = reporter.observerFor('lead_followups');

    observer.onTick({ ok: true });
    observer.onTick({ errorCode: 'provider_rejected', ok: false });
    observer.onTick({ ok: true });
    await reporter.flush();

    expect(heartbeatCalls(calls)[0]?.args).toMatchObject({
      target_error_code: 'provider_rejected',
      target_succeeded: false,
    });
  });

  it('normalises an unapproved error code instead of persisting free-form text', async () => {
    const { calls, reporter } = reporterFor();
    await reporter.register();

    // Short enough to have passed a length check, and exactly the kind of value that must
    // never reach an operational table.
    reporter.observerFor('message_processing').onTick({ errorCode: '+15551234567', ok: false });
    await reporter.flush();
    reporter.observerFor('billing_events').onTick({ errorCode: 'x'.repeat(400), ok: false });
    await reporter.flush();

    const codes = heartbeatCalls(calls).map((call) => call.args.target_error_code);
    expect(codes).not.toContain('+15551234567');
    expect(codes.every((code) => code === null || code === 'unexpected_error')).toBe(true);
  });

  it('advances the process heartbeat with zero components configured', async () => {
    const { calls, reporter } = reporterFor({
      instanceId: '66666666-6666-4666-8666-666666666666',
    });
    await reporter.register();

    // A core-only API deployment: no messaging, reminders, follow-ups, or billing worker.
    await reporter.flush();
    await reporter.flush();
    await reporter.flush();

    const instanceBeats = calls.filter((call) => call.name === 'heartbeat_runtime_instance');
    expect(instanceBeats).toHaveLength(3);
    expect(instanceBeats[0]?.args).toEqual({
      target_instance_id: '66666666-6666-4666-8666-666666666666',
    });
    // No fake component is invented just to keep the process visible.
    expect(heartbeatCalls(calls)).toHaveLength(0);
  });

  it('marks components stopped and stops only its own instance', async () => {
    const { calls, reporter } = reporterFor({ instanceId: '22222222-2222-4222-8222-222222222222' });
    await reporter.register();
    reporter.observerFor('message_processing').onStart();
    await reporter.flush();

    await reporter.stop();

    const stopCall = calls.find((call) => call.name === 'stop_runtime_instance');
    expect(stopCall?.args).toEqual({
      target_instance_id: '22222222-2222-4222-8222-222222222222',
    });
    expect(heartbeatCalls(calls).at(-1)?.args).toMatchObject({ target_state: 'stopped' });
  });

  it('retains a pending outcome and keeps running when a heartbeat write fails', async () => {
    const warn = vi.fn();
    const rpc = vi.fn((name: string) =>
      Promise.resolve({
        error: name === 'heartbeat_runtime_component' ? { message: 'unavailable' } : null,
      }),
    );
    const reporter = new RuntimeHeartbeatReporter({
      client: { rpc } as unknown as SupabaseClient<Database>,
      instanceId: '33333333-3333-4333-8333-333333333333',
      logger: { warn },
      release: 'abc123',
    });
    await reporter.register();
    reporter.observerFor('appointment_reminders').onTick({ ok: true });

    await expect(reporter.flush()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    const [payload] = warn.mock.calls[0] ?? [];
    expect(payload).toMatchObject({ component: 'runtime_heartbeat', outcome: 'failed' });
  });
});

describe('multiple runtime instances', () => {
  it('keeps two processes independent and stops only the one that is shutting down', async () => {
    const first = reporterFor({ instanceId: '44444444-4444-4444-8444-444444444444' });
    const second = reporterFor({ instanceId: '55555555-5555-4555-8555-555555555555' });
    await first.reporter.register();
    await second.reporter.register();
    first.reporter.observerFor('message_processing').onStart();
    second.reporter.observerFor('message_processing').onStart();

    await first.reporter.stop();
    second.reporter.observerFor('message_processing').onTick({ ok: true });
    await second.reporter.flush();

    const firstStop = first.calls.find((call) => call.name === 'stop_runtime_instance');
    expect(firstStop?.args).toEqual({
      target_instance_id: '44444444-4444-4444-8444-444444444444',
    });
    expect(second.calls.some((call) => call.name === 'stop_runtime_instance')).toBe(false);
    // The surviving process keeps reporting under its own identity.
    expect(heartbeatCalls(second.calls).at(-1)?.args).toMatchObject({
      target_instance_id: '55555555-5555-4555-8555-555555555555',
      target_state: 'running',
      target_succeeded: true,
    });
  });
});

describe('runtime heartbeat transport failures', () => {
  /** A Supabase client can reject as well as resolve with an error; both must be absorbed. */
  function throwingReporter(input: { readonly throwOn: string; readonly instanceId?: string }) {
    const warn = vi.fn();
    const calls: RpcCall[] = [];
    const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
      calls.push({ args, name });
      if (name === input.throwOn) {
        // Shaped like a real Node transport failure: the message carries exactly the detail
        // that must never be logged, and the machine-readable code is what may be read.
        const failure = Object.assign(
          new Error('connect ECONNREFUSED https://secret-db-host.example.internal:5432'),
          { code: 'ECONNREFUSED' },
        );
        return Promise.reject(failure);
      }
      return Promise.resolve({ error: null });
    });
    const reporter = new RuntimeHeartbeatReporter({
      client: { rpc } as unknown as SupabaseClient<Database>,
      instanceId: input.instanceId ?? '77777777-7777-4777-8777-777777777777',
      logger: { warn },
      release: 'abc123',
    });
    return { calls, reporter, warn };
  }

  function loggedText(warn: ReturnType<typeof vi.fn>): string {
    return JSON.stringify(warn.mock.calls);
  }

  it('survives a rejected register_runtime_instance and stays recoverable', async () => {
    const { reporter, warn } = throwingReporter({ throwOn: 'register_runtime_instance' });

    await expect(reporter.register()).resolves.toBe(false);

    expect(warn).toHaveBeenCalled();
    const [payload] = warn.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      component: 'runtime_heartbeat',
      error_code: 'database_unavailable',
      operation: 'runtime.heartbeat.register_failed',
      outcome: 'failed',
    });
    // Never the database host, the transport message, or a stack trace.
    expect(loggedText(warn)).not.toContain('secret-db-host');
    expect(loggedText(warn)).not.toContain('ECONNREFUSED');
    expect(loggedText(warn)).not.toContain('https://');

    // A later flush retries registration rather than giving up permanently.
    await expect(reporter.flush()).resolves.toBeUndefined();
  });

  it('survives a rejected heartbeat_runtime_instance without an unhandled rejection', async () => {
    const { calls, reporter, warn } = throwingReporter({ throwOn: 'heartbeat_runtime_instance' });
    await reporter.register();
    reporter.observerFor('message_processing').onTick({ ok: true });

    await expect(reporter.flush()).resolves.toBeUndefined();

    expect(
      warn.mock.calls.some(
        ([payload]) =>
          (payload as { operation?: unknown }).operation ===
          'runtime.heartbeat.instance_write_failed',
      ),
    ).toBe(true);
    // The component write is skipped once the instance write failed, and nothing threw.
    expect(calls.some((call) => call.name === 'heartbeat_runtime_component')).toBe(false);
    expect(loggedText(warn)).not.toContain('secret-db-host');
  });

  it('survives a rejected heartbeat_runtime_component and keeps the pending outcome', async () => {
    const { calls, reporter, warn } = throwingReporter({ throwOn: 'heartbeat_runtime_component' });
    await reporter.register();
    reporter.observerFor('billing_events').onTick({ errorCode: 'provider_timeout', ok: false });

    await expect(reporter.flush()).resolves.toBeUndefined();
    await expect(reporter.flush()).resolves.toBeUndefined();

    // The failed outcome is reported again rather than being lost.
    const componentWrites = calls.filter((call) => call.name === 'heartbeat_runtime_component');
    expect(componentWrites.length).toBeGreaterThanOrEqual(2);
    expect(componentWrites.at(-1)?.args).toMatchObject({
      target_error_code: 'provider_timeout',
      target_succeeded: false,
    });
    expect(loggedText(warn)).not.toContain('secret-db-host');
  });

  it('survives a rejected stop_runtime_instance so shutdown still completes', async () => {
    const { reporter, warn } = throwingReporter({ throwOn: 'stop_runtime_instance' });
    await reporter.register();
    reporter.observerFor('lead_followups').onStart();

    await expect(reporter.stop()).resolves.toBeUndefined();

    expect(
      warn.mock.calls.some(
        ([payload]) =>
          (payload as { operation?: unknown }).operation === 'runtime.heartbeat.stop_failed',
      ),
    ).toBe(true);
    expect(loggedText(warn)).not.toContain('secret-db-host');
  });

  it('still records the stop after an immediately preceding component write failed', async () => {
    const { calls, reporter } = throwingReporter({ throwOn: 'heartbeat_runtime_component' });
    await reporter.register();
    reporter.observerFor('message_processing').onStart();
    await reporter.flush();

    await reporter.stop();

    // The durable stop is attempted regardless: leaving stopped_at null would make a clean exit
    // indistinguishable from a crash for the whole retention window.
    expect(calls.filter((call) => call.name === 'stop_runtime_instance')).toHaveLength(1);
    // And the stopped instance is never re-registered on the way out.
    const registrations = calls.filter((call) => call.name === 'register_runtime_instance');
    expect(registrations).toHaveLength(1);
  });
});

describe('component lifecycle through a deferred observer', () => {
  /**
   * The full component story against the real reporter and a fake RPC boundary: an observer
   * acquired before the reporter existed, then start, an empty successful tick, a failure, a
   * recovery, and a stop.
   */
  it('carries start, empty success, failure, recovery, and stop to durable writes', async () => {
    const { calls, reporter } = reporterFor({
      instanceId: '88888888-8888-4888-8888-888888888888',
    });

    // Handed out before the reporter is registered, exactly as bootstrap does it.
    let current: RuntimeHeartbeatReporter | null = null;
    const deferred = {
      onStart: () => current?.observerFor('message_processing').onStart(),
      onStop: () => current?.observerFor('message_processing').onStop(),
      onTick: (outcome: WorkerTickOutcome) =>
        current?.observerFor('message_processing').onTick(outcome),
    };
    // Every call before this point is silently dropped, which is the no-reporter contract.
    deferred.onTick({ ok: true });
    current = reporter;

    await reporter.register();

    deferred.onStart();
    await reporter.flush();
    // An empty poll is a healthy tick, not silence.
    deferred.onTick({ ok: true });
    await reporter.flush();
    deferred.onTick({ errorCode: 'provider_timeout', ok: false });
    await reporter.flush();
    deferred.onTick({ ok: true });
    await reporter.flush();
    await reporter.stop();

    const writes = heartbeatCalls(calls).map((call) => ({
      error: call.args.target_error_code,
      state: call.args.target_state,
      succeeded: call.args.target_succeeded,
    }));

    expect(writes).toEqual([
      // Start: running, with no outcome to report yet.
      { error: null, state: 'running', succeeded: null },
      // Empty successful tick.
      { error: null, state: 'running', succeeded: true },
      // Failure, with a bounded approved code.
      { error: 'provider_timeout', state: 'running', succeeded: false },
      // Recovery clears the code; the reporter's failure streak resets on the database side.
      { error: null, state: 'running', succeeded: true },
      // Shutdown.
      { error: null, state: 'stopped', succeeded: null },
    ]);
    expect(calls.filter((call) => call.name === 'stop_runtime_instance')).toHaveLength(1);
  });
});
