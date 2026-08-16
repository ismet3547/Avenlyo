'use client';

import { useActionState } from 'react';

import type { FormActionState } from '@/lib/forms/state';
import { initialFormActionState } from '@/lib/forms/state';

import { FormMessage } from './form-feedback';
import { SubmitButton } from './submit-button';

interface SingleActionFormProps {
  action: (state: FormActionState, formData: FormData) => Promise<FormActionState>;
  fieldName: string;
  fieldValue: string;
  label: string;
  pendingLabel?: string | undefined;
}

export function SingleActionForm({
  action,
  fieldName,
  fieldValue,
  label,
  pendingLabel,
}: SingleActionFormProps) {
  const [state, formAction] = useActionState(action, initialFormActionState);

  return (
    <form action={formAction} className="space-y-4">
      <input name={fieldName} type="hidden" value={fieldValue} />
      <FormMessage state={state} />
      <div className="flex justify-end">
        <SubmitButton label={label} pendingLabel={pendingLabel} />
      </div>
    </form>
  );
}
