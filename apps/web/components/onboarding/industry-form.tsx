'use client';

import { dentalPack } from '@avenlyo/industries';
import { useActionState } from 'react';

import { saveIndustryAction } from '@/app/onboarding/actions';
import { initialFormActionState } from '@/lib/forms/state';

import { FieldError, FormMessage } from './form-feedback';
import { SubmitButton } from './submit-button';

export function IndustryForm() {
  const [state, action] = useActionState(saveIndustryAction, initialFormActionState);

  return (
    <form action={action} className="mt-9" noValidate>
      <fieldset>
        <legend className="sr-only">Dental clinic industry</legend>
        <label className="group relative block cursor-pointer">
          <input
            defaultChecked
            className="peer sr-only"
            name="industryId"
            type="radio"
            value="dental"
          />
          <span className="flex min-h-40 flex-col rounded-2xl border border-primary bg-primary/[0.035] p-5 shadow-sm peer-focus-visible:ring-4 peer-focus-visible:ring-primary/15">
            <span className="font-display text-lg font-semibold tracking-tight text-ink">
              {dentalPack.name}
            </span>
            <span className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {dentalPack.description}
            </span>
            <span className="mt-auto pt-4 font-utility text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
              Avenlyo V1 focus
            </span>
          </span>
        </label>
        <FieldError errors={state.fieldErrors?.industryId} />
      </fieldset>

      <div className="mt-8 space-y-4">
        <FormMessage state={state} />
        <div className="flex justify-end">
          <SubmitButton label="Continue with dental clinic" />
        </div>
      </div>
    </form>
  );
}
