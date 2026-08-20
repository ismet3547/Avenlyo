import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AuthForm } from '@/components/auth-form';
import { safeNextDestination } from '@/lib/auth/next-destination';
import type { FormActionState } from '@/lib/forms/state';

/**
 * The real form, rendered.
 *
 * The reviewed head had a green suite for `safeNextDestination` and `authLinkWithNext` while the
 * invitation flow was dead end to end, because the form never carried the destination and the
 * mode-switch links dropped it. Helper tests could not see that. These assertions render the
 * component that actually ships and read the markup a browser would submit.
 */

const INVITE = '/invite/abc123def456';

const noopAction = (): Promise<FormActionState> => Promise.resolve({ status: 'idle' });

function render(props: { mode: 'sign-in' | 'sign-up'; next?: string | undefined }): string {
  return renderToStaticMarkup(
    createElement(AuthForm, {
      action: noopAction,
      mode: props.mode,
      ...(props.next === undefined ? {} : { next: props.next }),
    }),
  );
}

describe('auth form continuation field', () => {
  it('renders a hidden next field carrying the invitation', () => {
    const html = render({ mode: 'sign-in', next: INVITE });
    expect(html).toContain(`<input type="hidden" name="next" value="${INVITE}"/>`);
  });

  it('renders no hidden field for an ordinary sign-in', () => {
    const html = render({ mode: 'sign-in' });
    expect(html).not.toContain('name="next"');
  });

  it('carries the invitation on a sign-up form too', () => {
    const html = render({ mode: 'sign-up', next: INVITE });
    expect(html).toContain(`<input type="hidden" name="next" value="${INVITE}"/>`);
    // The sign-up form still collects its own fields; the continuation is additive.
    expect(html).toContain('name="confirmPassword"');
  });
});

describe('auth form mode switch', () => {
  it('preserves the invitation when moving from sign-in to create account', () => {
    const html = render({ mode: 'sign-in', next: INVITE });
    expect(html).toContain(`href="/auth/sign-up?next=${encodeURIComponent(INVITE)}"`);
  });

  it('preserves the invitation when moving from sign-up back to sign in', () => {
    const html = render({ mode: 'sign-up', next: INVITE });
    expect(html).toContain(`href="/auth/sign-in?next=${encodeURIComponent(INVITE)}"`);
  });

  it('links to the bare auth pages when there is no continuation', () => {
    expect(render({ mode: 'sign-in' })).toContain('href="/auth/sign-up"');
    expect(render({ mode: 'sign-up' })).toContain('href="/auth/sign-in"');
  });
});

describe('auth form never renders an unvalidated destination', () => {
  it('drops a hostile value that a page failed to validate', () => {
    for (const hostile of ['https://evil.example', '//evil.example', 'javascript:alert(1)']) {
      // The pages validate first, so this is the value the form actually receives.
      const validated = safeNextDestination(hostile) ?? undefined;
      const html = render({ mode: 'sign-in', next: validated });

      expect(html).not.toContain('name="next"');
      expect(html).not.toContain('evil.example');
      expect(html).not.toContain('javascript:alert');
      // The switch link falls back to the bare path rather than carrying the hostile value.
      expect(html).toContain('href="/auth/sign-up"');
    }
  });
});
