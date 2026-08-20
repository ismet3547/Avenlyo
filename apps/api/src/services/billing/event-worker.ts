import { randomUUID } from 'node:crypto';

import { classifyError } from '../../observability/errors.js';
import type { WorkerObserver } from '../../observability/worker-observer.js';

import type { BillingService } from './billing-service.js';
import type { StripeWebhookClaim } from './types.js';

const IDLE_POLL_MS = 15_000;

export interface BillingWorkerLogger {
  error(message: string, error?: unknown): void;
}

/**
 * Durable Stripe-event worker. Claims are independent: one failed provider read is immediately
 * requeued without delaying siblings, while lease recovery remains protection for a hard crash.
 */
export class BillingEventWorker {
  private active = false;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private tickErrorCode: string | null = null;
  private readonly workerId = `billing-${randomUUID()}`;

  public constructor(
    private readonly service: BillingService,
    private readonly logger?: BillingWorkerLogger,
    private readonly observer?: WorkerObserver,
  ) {}

  public start(): void {
    if (this.stopped || this.timer) return;
    this.observer?.onStart();
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
    this.observer?.onStop();
  }

  /** Exposed for deterministic worker tests and safe one-shot host execution. */
  public async pollOnce(): Promise<void> {
    if (this.active || this.stopped) return;
    this.active = true;
    this.tickErrorCode = null;
    this.inFlight = this.run();
    try {
      await this.inFlight;
      // An empty claim batch is a healthy tick; only a real failure breaks the streak.
      this.observer?.onTick(
        this.tickErrorCode ? { errorCode: this.tickErrorCode, ok: false } : { ok: true },
      );
    } catch (error) {
      this.tickErrorCode ??= classifyError(error);
      this.observer?.onTick({ errorCode: this.tickErrorCode, ok: false });
      this.log('Billing event worker batch failed.', error);
    } finally {
      this.inFlight = null;
      this.active = false;
      if (!this.stopped) this.schedule(IDLE_POLL_MS);
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce();
    }, delay);
  }

  private async run(): Promise<void> {
    const claims = await this.service.claimEvents(this.workerId, 10);
    for (const claim of claims) {
      await this.processClaim(claim);
    }
  }

  private async processClaim(claim: StripeWebhookClaim): Promise<void> {
    try {
      const event = await this.service.retrieveClaimedEvent(claim);
      await this.service.completeEvent(event.id, await this.service.processClaimedEvent(event));
    } catch (error) {
      this.tickErrorCode ??= classifyError(error);
      try {
        await this.service.failEvent(
          claim.stripeEventId,
          error instanceof Error ? error.name : 'billing_worker_failure',
        );
      } catch (failureError) {
        this.log('Billing event worker could not record an event failure.', failureError);
      }
    }
  }

  private log(message: string, error: unknown): void {
    try {
      this.logger?.error(message, error);
    } catch {
      // Logging must never create an unhandled worker rejection.
    }
  }
}
