import { describe, expect, it, vi } from 'vitest';

import { beginSubmission, pendingSubmissionAfterFailure } from './submission';

describe('agent test submission idempotency', () => {
  it('reuses the initial UUID through transient and running retry outcomes', () => {
    const createKey = vi.fn(() => '00000000-0000-0000-0000-000000000001');
    const initial = beginSubmission(null, 'Hours?', createKey);

    expect(pendingSubmissionAfterFailure(initial, 'reuse-key')).toBe(initial);
    expect(beginSubmission(initial, 'Hours?', createKey)).toBe(initial);
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it('requires a new explicit send key after a terminal failed submission', () => {
    const createKey = vi
      .fn<() => string>()
      .mockReturnValueOnce('00000000-0000-0000-0000-000000000001')
      .mockReturnValueOnce('00000000-0000-0000-0000-000000000002');
    const initial = beginSubmission(null, 'Hours?', createKey);

    expect(pendingSubmissionAfterFailure(initial, 'replace-key')).toBeNull();
    expect(beginSubmission(null, 'Hours?', createKey)).toEqual({
      idempotencyKey: '00000000-0000-0000-0000-000000000002',
      message: 'Hours?',
    });
  });

  it('does not create a replacement key while a completed duplicate is replayed', () => {
    const createKey = vi.fn(() => '00000000-0000-0000-0000-000000000001');
    const initial = beginSubmission(null, 'Hours?', createKey);

    expect(beginSubmission(initial, 'Hours?', createKey)).toBe(initial);
    expect(createKey).toHaveBeenCalledTimes(1);
  });
});
