import { randomUUID } from 'node:crypto';

import type { BillingService } from './billing-service.js';

const IDLE_POLL_MS = 15_000;

/** Durable Stripe-event worker; each provider event is claimed in PostgreSQL before any Stripe read. */
export class BillingEventWorker {
  private active = false;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly workerId = `billing-${randomUUID()}`;

  public constructor(private readonly service: BillingService) {}

  public start(): void {
    if (this.stopped || this.timer) return;
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.active || this.stopped) return;
    this.active = true;
    this.inFlight = this.run();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
      this.active = false;
      this.schedule(IDLE_POLL_MS);
    }
  }

  private async run(): Promise<void> {
    const events = await this.service.claimEvents(this.workerId, 10);
    await Promise.all(
      events.map(async (event) => {
        try {
          await this.service.completeEvent(event.id, await this.service.processClaimedEvent(event));
        } catch (error) {
          await this.service.failEvent(
            event.id,
            error instanceof Error ? error.name : 'billing_worker_failure',
          );
        }
      }),
    );
  }
}
