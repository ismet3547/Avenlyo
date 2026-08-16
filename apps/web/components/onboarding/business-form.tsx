'use client';

import { useActionState } from 'react';

import { saveBusinessAction } from '@/app/onboarding/actions';
import { initialFormActionState } from '@/lib/forms/state';

import { FieldError, FormMessage } from './form-feedback';
import { SubmitButton } from './submit-button';

interface BusinessFormProps {
  initialName: string;
  initialPhone: string | null;
  initialWebsiteUrl: string | null;
}

export function BusinessForm({ initialName, initialPhone, initialWebsiteUrl }: BusinessFormProps) {
  const [state, action] = useActionState(saveBusinessAction, initialFormActionState);
  const displayName = initialName === 'New Avenlyo workspace' ? '' : initialName;

  return (
    <form action={action} className="mt-9 space-y-6" noValidate>
      <div>
        <label className="text-sm font-semibold text-ink" htmlFor="name">
          Business name
        </label>
        <input
          autoComplete="organization"
          className="avenlyo-input mt-2"
          defaultValue={displayName}
          id="name"
          name="name"
          placeholder="North Star Veterinary"
          required
        />
        <FieldError errors={state.fieldErrors?.name} />
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label className="text-sm font-semibold text-ink" htmlFor="websiteUrl">
            Website <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            autoComplete="url"
            className="avenlyo-input mt-2"
            defaultValue={initialWebsiteUrl ?? ''}
            id="websiteUrl"
            name="websiteUrl"
            placeholder="https://example.com"
            type="url"
          />
          <FieldError errors={state.fieldErrors?.websiteUrl} />
        </div>

        <div>
          <label className="text-sm font-semibold text-ink" htmlFor="phone">
            Phone <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            autoComplete="tel"
            className="avenlyo-input mt-2"
            defaultValue={initialPhone ?? ''}
            id="phone"
            name="phone"
            placeholder="+90 555 123 4567"
            type="tel"
          />
          <FieldError errors={state.fieldErrors?.phone} />
        </div>
      </div>

      <FormMessage state={state} />
      <div className="flex justify-end border-t border-slate-100 pt-6">
        <SubmitButton label="Continue to location" />
      </div>
    </form>
  );
}
