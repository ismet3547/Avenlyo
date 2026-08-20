'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { Button } from '@/components/ui/button';
import { authLinkWithNext } from '@/lib/auth/next-destination';
import { initialFormActionState, type FormActionState } from '@/lib/forms/state';

interface AuthFormProps {
  action: (state: FormActionState, formData: FormData) => Promise<FormActionState>;
  mode: 'sign-in' | 'sign-up';
  /**
   * Where to continue after authentication, typically a pending invitation.
   *
   * Must already have passed `safeNextDestination` on the server. This component renders the value
   * into a hidden field and a link, so accepting an unvalidated one here would put an
   * attacker-chosen destination straight into the form the user is about to submit.
   */
  next?: string | undefined;
}

function SubmitButton({ mode }: Pick<AuthFormProps, 'mode'>) {
  const { pending } = useFormStatus();

  return (
    <Button className="mt-2 h-11 w-full" disabled={pending} type="submit">
      {pending ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
    </Button>
  );
}

function FieldError({ errors }: { errors?: string[] | undefined }) {
  if (!errors?.[0]) return null;
  return <p className="mt-1.5 text-xs font-medium text-red-700">{errors[0]}</p>;
}

export function AuthForm({ action, mode, next }: AuthFormProps) {
  const [state, formAction] = useActionState(action, initialFormActionState);
  const isSignUp = mode === 'sign-up';
  const switchHref = authLinkWithNext(isSignUp ? '/auth/sign-in' : '/auth/sign-up', next);

  return (
    <form action={formAction} className="mt-8 space-y-5" noValidate>
      {/* The continuation has to survive the submit, or an invited person is authenticated and
          then sent to onboarding, where they would bootstrap a workspace nobody asked for. */}
      {next ? <input name="next" type="hidden" value={next} /> : null}
      <div>
        <label className="text-sm font-medium text-ink" htmlFor="email">
          Email address
        </label>
        <input
          autoComplete="email"
          className="avenlyo-input mt-2"
          id="email"
          name="email"
          placeholder="you@business.com"
          required
          type="email"
        />
        <FieldError errors={state.fieldErrors?.email} />
      </div>

      <div>
        <label className="text-sm font-medium text-ink" htmlFor="password">
          Password
        </label>
        <input
          autoComplete={isSignUp ? 'new-password' : 'current-password'}
          className="avenlyo-input mt-2"
          id="password"
          minLength={8}
          name="password"
          required
          type="password"
        />
        <FieldError errors={state.fieldErrors?.password} />
      </div>

      {isSignUp ? (
        <div>
          <label className="text-sm font-medium text-ink" htmlFor="confirmPassword">
            Confirm password
          </label>
          <input
            autoComplete="new-password"
            className="avenlyo-input mt-2"
            id="confirmPassword"
            minLength={8}
            name="confirmPassword"
            required
            type="password"
          />
          <FieldError errors={state.fieldErrors?.confirmPassword} />
        </div>
      ) : null}

      {state.message ? (
        <div
          aria-live="polite"
          className={
            state.status === 'success'
              ? 'rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900'
              : 'rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900'
          }
          role="status"
        >
          {state.message}
        </div>
      ) : null}

      <SubmitButton mode={mode} />

      <p className="text-center text-sm text-muted-foreground">
        {isSignUp ? 'Already have an account?' : 'New to Avenlyo?'}{' '}
        <Link className="font-semibold text-primary hover:underline" href={switchHref}>
          {isSignUp ? 'Sign in' : 'Create an account'}
        </Link>
      </p>
    </form>
  );
}
