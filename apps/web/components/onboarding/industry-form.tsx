'use client';

import { industryPacks } from '@avenlyo/industries';
import { Building2 } from 'lucide-react';
import { useActionState } from 'react';

import { saveIndustryAction } from '@/app/onboarding/actions';
import { initialFormActionState } from '@/lib/forms/state';

import { FieldError, FormMessage } from './form-feedback';
import { SubmitButton } from './submit-button';

export function IndustryForm({ selectedIndustryId }: { selectedIndustryId: string | null }) {
  const [state, action] = useActionState(saveIndustryAction, initialFormActionState);

  return (
    <form action={action} className="mt-9" noValidate>
      <fieldset>
        <legend className="sr-only">Choose an industry</legend>
        <div className="grid gap-3 md:grid-cols-2">
          {industryPacks.map((pack) => (
            <label className="group relative cursor-pointer" key={pack.id}>
              <input
                className="peer sr-only"
                defaultChecked={selectedIndustryId === pack.id}
                name="industryId"
                type="radio"
                value={pack.id}
              />
              <span className="flex min-h-40 flex-col rounded-2xl border border-slate-200 p-5 transition group-hover:-translate-y-0.5 group-hover:border-primary/40 group-hover:shadow-md peer-checked:border-primary peer-checked:bg-primary/[0.035] peer-focus-visible:ring-4 peer-focus-visible:ring-primary/15">
                <span className="font-display text-lg font-semibold tracking-tight text-ink">
                  {pack.name}
                </span>
                <span className="mt-2 text-sm leading-6 text-muted-foreground">
                  {pack.description}
                </span>
                <span className="mt-auto pt-4 font-utility text-[10px] font-semibold uppercase tracking-[0.16em] text-primary opacity-0 transition peer-checked:opacity-100">
                  Selected
                </span>
              </span>
            </label>
          ))}

          <div
            aria-disabled="true"
            className="flex min-h-40 flex-col rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 p-5 text-slate-400"
          >
            <Building2 aria-hidden="true" className="size-5" />
            <span className="mt-3 font-display text-lg font-semibold tracking-tight">
              Other business
            </span>
            <span className="mt-2 text-sm leading-6">More industry packs are coming soon.</span>
            <span className="mt-auto pt-4 font-utility text-[10px] font-semibold uppercase tracking-[0.16em]">
              Coming soon
            </span>
          </div>
        </div>
        <FieldError errors={state.fieldErrors?.industryId} />
      </fieldset>

      <div className="mt-8 space-y-4">
        <FormMessage state={state} />
        <div className="flex justify-end">
          <SubmitButton label="Continue to business" />
        </div>
      </div>
    </form>
  );
}
