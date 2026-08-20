import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { RuntimeHeartbeatReporter } from './heartbeat.js';

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

  it('never writes a stack trace, payload, or customer value', async () => {
    const { calls, reporter } = reporterFor();
    await reporter.register();

    reporter.observerFor('message_processing').onTick({ errorCode: 'x'.repeat(400), ok: false });
    await reporter.flush();

    const errorCode = heartbeatCalls(calls)[0]?.args.target_error_code;
    expect(typeof errorCode).toBe('string');
    expect((errorCode as string).length).toBeLessThanOrEqual(60);
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
