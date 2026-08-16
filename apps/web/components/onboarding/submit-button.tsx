'use client';

import { ArrowRight } from 'lucide-react';
import { useFormStatus } from 'react-dom';

import { Button } from '@/components/ui/button';

interface SubmitButtonProps {
  label: string;
  pendingLabel?: string | undefined;
}

export function SubmitButton({ label, pendingLabel = 'Saving…' }: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button className="h-11 gap-2 px-5" disabled={pending} type="submit">
      {pending ? pendingLabel : label}
      {!pending ? <ArrowRight aria-hidden="true" className="size-4" /> : null}
    </Button>
  );
}
