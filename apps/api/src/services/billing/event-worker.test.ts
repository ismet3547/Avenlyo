import { describe, expect, it, vi } from 'vitest';

import type { BillingService } from './billing-service.js';
import { BillingEventWorker } from './event-worker.js';
import type { StripeWebhookClaim, StripeWebhookEventRecord } from './types.js';

function claim(id: string): StripeWebhookClaim {
  return {
    attemptCount: 1,
    eventType: 'invoice.paid',
    livemode: false,
    stripeEventId: id,
    stripeObjectId: `in_${id}`,
  };
}

function event(id: string): StripeWebhookEventRecord {
  return {
    createdAt: new Date('2026-08-25T00:00:00.000Z'),
    id,
    livemode: false,
    object: { customer: 'cus_worker', id: `in_${id}` },
    objectId: `in_${id}`,
    type: 'invoice.paid',
  };
}

function workerService(input: {
  readonly claims: readonly StripeWebhookClaim[];
  readonly claimError?: Error;
  readonly processError?: Error;
  readonly retrieveErrorFor?: string;
}) {
  const claimEvents = vi.fn(() =>
    input.claimError ? Promise.reject(input.claimError) : Promise.resolve(input.claims),
  );
  const retrieveClaimedEvent = vi.fn((nextClaim: StripeWebhookClaim) =>
    nextClaim.stripeEventId === input.retrieveErrorFor
      ? Promise.reject(new Error('Stripe read failed'))
      : Promise.resolve(event(nextClaim.stripeEventId)),
  );
  const processClaimedEvent = vi.fn(() =>
    input.processError ? Promise.reject(input.processError) : Promise.resolve<'processed'>('processed'),
  );
  const completeEvent = vi.fn(() => Promise.resolve());
  const failEvent = vi.fn(() => Promise.resolve());
  const service = {
    claimEvents,
    completeEvent,
    failEvent,
    processClaimedEvent,
    retrieveClaimedEvent,
  } as unknown as BillingService;
  return { claimEvents, completeEvent, failEvent, processClaimedEvent, service };
}

describe('billing event worker', () => {
  it('processes sibling claims when the middle provider retrieval fails', async () => {
    const fake = workerService({
      claims: [claim('evt_a'), claim('evt_b'), claim('evt_c')],
      retrieveErrorFor: 'evt_b',
    });
    const worker = new BillingEventWorker(fake.service);
    await worker.pollOnce();
    await worker.stop();
    expect(fake.completeEvent).toHaveBeenCalledTimes(2);
    expect(fake.failEvent).toHaveBeenCalledWith('evt_b', 'Error');
  });

  it('returns an individual processing failure to its durable retry path', async () => {
    const fake = workerService({ claims: [claim('evt_a')], processError: new Error('apply failed') });
    const worker = new BillingEventWorker(fake.service);
    await worker.pollOnce();
    await worker.stop();
    expect(fake.completeEvent).not.toHaveBeenCalled();
    expect(fake.failEvent).toHaveBeenCalledWith('evt_a', 'Error');
  });

  it('contains an unexpected claim failure and permits a later poll', async () => {
    const claimEvents = vi
      .fn<() => Promise<readonly StripeWebhookClaim[]>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce([]);
    const logger = { error: vi.fn() };
    const service = {
      claimEvents,
      completeEvent: vi.fn(() => Promise.resolve()),
      failEvent: vi.fn(() => Promise.resolve()),
      processClaimedEvent: vi.fn(() => Promise.resolve<'processed'>('processed')),
      retrieveClaimedEvent: vi.fn(() => Promise.resolve(event('evt_unused'))),
    } as unknown as BillingService;
    const worker = new BillingEventWorker(service, logger);
    await worker.pollOnce();
    await worker.pollOnce();
    await worker.stop();
    expect(claimEvents).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
