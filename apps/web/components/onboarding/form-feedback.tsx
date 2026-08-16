import type { FormActionState } from '@/lib/forms/state';

export function FieldError({ errors }: { errors?: string[] | undefined }) {
  if (!errors?.[0]) return null;
  return <p className="mt-1.5 text-xs font-medium text-red-700">{errors[0]}</p>;
}

export function FormMessage({ state }: { state: FormActionState }) {
  if (!state.message) return null;

  return (
    <p
      aria-live="polite"
      className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900"
      role="status"
    >
      {state.message}
    </p>
  );
}
