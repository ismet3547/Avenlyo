'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Watches an import that is still queued or running.
 *
 * The crawl happens in the API worker now, so this page can be opened before there is anything to
 * review. Polling is deliberately bounded: an import that outlives the window is not lost, it is
 * simply no longer worth a timer in an idle tab, and the operator is told to refresh instead of
 * being left with a spinner that turns forever.
 */

const POLL_INTERVAL_MS = 4_000;
/** Roughly three minutes, comfortably longer than a normal import and far shorter than forever. */
const MAX_POLLS = 45;

export function ImportProgress({ status }: { status: 'pending' | 'running' }) {
  const router = useRouter();
  const [polls, setPolls] = useState(0);
  const exhausted = polls >= MAX_POLLS;

  useEffect(() => {
    if (exhausted) return undefined;
    const timer = setTimeout(() => {
      setPolls((previous) => previous + 1);
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [exhausted, polls, router]);

  return (
    <div
      aria-live="polite"
      className="rounded-xl border border-border bg-white p-6 shadow-sm"
      data-testid="import-progress"
    >
      <div className="flex items-center gap-3">
        {exhausted ? null : (
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
          />
        )}
        <p className="font-semibold text-ink">
          {status === 'pending' ? 'Queued for import' : 'Reading this website'}
        </p>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        {exhausted
          ? 'This import is taking longer than usual. It is still queued — refresh this page to check again.'
          : 'Pages are being collected in the background. This page updates on its own, and you can safely leave and come back.'}
      </p>
    </div>
  );
}
