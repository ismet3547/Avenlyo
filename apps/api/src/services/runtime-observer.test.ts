import { describe, expect, it, vi } from 'vitest';

import type { RuntimeComponent } from '../observability/runtime-state.js';
import type { WorkerObserver } from '../observability/worker-observer.js';

/**
 * Coverage for the real runtime factories, not a stand-in for them.
 *
 * Both factories resolve `observerFor(component)` while they construct their workers and store the
 * result in a field. Bootstrap cannot have a heartbeat reporter at that moment, so what these tests
 * prove is that an observer acquired during construction is still live once the reporter is
 * attached afterwards. A factory that captured a dead object would pass every other Phase 14 test
 * and silently report nothing in production.
 *
 * No provider or database call is made: the Supabase client is a stub, and each worker is stopped
 * before its scheduled tick can fire.
 */

const createServiceSupabaseClient = vi.fn();

vi.mock('../lib/supabase.js', () => ({
  createServiceSupabaseClient: (): unknown => createServiceSupabaseClient() as unknown,
}));

vi.mock('../env.js', () => ({
  env: {
    API_CORS_ORIGIN: 'https://app.example.test',
    OPENAI_AGENT_MODEL: 'gpt-test',
    OPENAI_API_KEY: 'sk-test-key',
    STRIPE_PRICE_CORE_MONTHLY: 'price_test',
    STRIPE_PRODUCT_CORE: 'prod_test',
    STRIPE_SECRET_KEY: 'sk_test_key',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'twilio-test-token',
    TWILIO_MESSAGING_WEBHOOK_BASE_URL: 'https://api.example.test',
  },
  expectedStripeLivemode: false,
  isEzyVetRuntimeConfigured: false,
  isGoogleCalendarRuntimeConfigured: false,
  isStripeBillingConfigured: true,
  isTwilioMessagingConfigured: true,
}));

const { createMessagingRuntime } = await import('./messaging/runtime.js');
const { createBillingRuntime } = await import('./billing/runtime.js');

interface CapturedEvent {
  readonly component: RuntimeComponent;
  readonly kind: 'start' | 'stop' | 'tick';
}

/**
 * The same shape bootstrap uses: a stable proxy per component that resolves a reporter which does
 * not exist yet. `attach` stands in for the reporter being constructed later.
 */
function deferredObservers() {
  const events: CapturedEvent[] = [];
  let attached = false;
  const cache = new Map<RuntimeComponent, WorkerObserver>();
  const record = (component: RuntimeComponent, kind: CapturedEvent['kind']) => {
    if (attached) events.push({ component, kind });
  };
  const observerFor = (component: RuntimeComponent): WorkerObserver => {
    const existing = cache.get(component);
    if (existing) return existing;
    const observer: WorkerObserver = {
      onStart: () => record(component, 'start'),
      onStop: () => record(component, 'stop'),
      onTick: () => record(component, 'tick'),
    };
    cache.set(component, observer);
    return observer;
  };
  return { attach: () => void (attached = true), events, observerFor };
}

function stubSupabase() {
  return { rpc: vi.fn(() => Promise.resolve({ data: [], error: null })) };
}

describe('messaging runtime observer wiring', () => {
  it('keeps the observers it acquired during construction live for its workers', async () => {
    createServiceSupabaseClient.mockReturnValue(stubSupabase());
    const deferred = deferredObservers();

    // Constructed while no reporter exists, exactly as bootstrap does it.
    const runtime = createMessagingRuntime({ observerFor: deferred.observerFor });
    expect(runtime).not.toBeNull();
    expect(runtime?.components).toEqual([
      'message_processing',
      'appointment_reminders',
      'lead_followups',
    ]);

    // The reporter arrives afterwards.
    deferred.attach();
    runtime?.start();
    // Stopped before any scheduled tick can fire, so no RPC and no provider call happens.
    await runtime?.stop();

    expect(deferred.events).toEqual([
      { component: 'message_processing', kind: 'start' },
      { component: 'appointment_reminders', kind: 'start' },
      { component: 'lead_followups', kind: 'start' },
      { component: 'message_processing', kind: 'stop' },
      { component: 'appointment_reminders', kind: 'stop' },
      { component: 'lead_followups', kind: 'stop' },
    ]);
  });

  it('acquires one observer per configured component and none for the rest', () => {
    createServiceSupabaseClient.mockReturnValue(stubSupabase());
    const acquired: RuntimeComponent[] = [];

    createMessagingRuntime({
      observerFor: (component) => {
        acquired.push(component);
        return { onStart: () => {}, onStop: () => {}, onTick: () => {} };
      },
    });

    expect(acquired).toEqual(['message_processing', 'appointment_reminders', 'lead_followups']);
    expect(acquired).not.toContain('billing_events');
  });

  it('builds nothing at all without the trusted backend', () => {
    createServiceSupabaseClient.mockReturnValue(null);
    const deferred = deferredObservers();

    expect(createMessagingRuntime({ observerFor: deferred.observerFor })).toBeNull();
    expect(deferred.events).toEqual([]);
  });
});

describe('billing runtime observer wiring', () => {
  it('keeps the observer it acquired during construction live for its worker', async () => {
    createServiceSupabaseClient.mockReturnValue(stubSupabase());
    const deferred = deferredObservers();

    const runtime = createBillingRuntime({ observerFor: deferred.observerFor });
    expect(runtime?.components).toEqual(['billing_events']);

    deferred.attach();
    runtime?.start();
    await runtime?.stop();

    expect(deferred.events).toEqual([
      { component: 'billing_events', kind: 'start' },
      { component: 'billing_events', kind: 'stop' },
    ]);
  });
});
