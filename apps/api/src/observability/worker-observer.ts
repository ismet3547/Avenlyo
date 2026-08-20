/**
 * The contract each durable worker uses to report its own liveness.
 *
 * A tick that finds no work is a successful tick: "no work" is healthy, and a component that keeps
 * reporting empty successful polls is exactly what a working idle deployment looks like.
 */

export type WorkerTickOutcome =
  { readonly ok: true } | { readonly ok: false; readonly errorCode: string };

export interface WorkerObserver {
  onStart(): void;
  onTick(outcome: WorkerTickOutcome): void;
  onStop(): void;
}

/** Used wherever a worker runs without observability wired in, such as focused unit tests. */
export const NOOP_WORKER_OBSERVER: WorkerObserver = {
  onStart: () => undefined,
  onStop: () => undefined,
  onTick: () => undefined,
};
