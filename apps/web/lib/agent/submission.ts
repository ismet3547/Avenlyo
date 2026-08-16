export type SubmissionDisposition = 'replace-key' | 'reuse-key';

export interface PendingSubmission {
  readonly idempotencyKey: string;
  readonly message: string;
}

/** Keeps transport retries stable but makes terminal failures a new, explicit user submission. */
export function beginSubmission(
  pending: PendingSubmission | null,
  message: string,
  createIdempotencyKey: () => string,
): PendingSubmission {
  return pending?.message === message
    ? pending
    : { idempotencyKey: createIdempotencyKey(), message };
}

export function pendingSubmissionAfterFailure(
  pending: PendingSubmission,
  disposition: SubmissionDisposition,
): PendingSubmission | null {
  return disposition === 'replace-key' ? null : pending;
}
