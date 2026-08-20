'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const REFRESH_INTERVAL_MS = 12_000;

/**
 * A small bounded refresh so an operator sees new work without navigating away. It reuses the
 * existing server-rendered queue instead of introducing an event platform, and it stops asking
 * while the tab is hidden.
 */
export function QueueAutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      router.refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [router]);

  return null;
}
