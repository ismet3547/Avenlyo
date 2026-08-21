'use client';

import { useActionState } from 'react';

import { saveVoiceConfigurationAction } from '@/app/dashboard/ai-front-office/voice/actions';
import { initialVoiceConfigurationActionState } from '@/app/dashboard/ai-front-office/voice/action-state';
import type { VoiceConfigurationView } from '@/lib/voice/types';

const voices = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
];

export function VoiceConfigurationForm({
  configuration,
}: {
  configuration: VoiceConfigurationView | null;
}) {
  const [state, action, isPending] = useActionState(
    saveVoiceConfigurationAction,
    initialVoiceConfigurationActionState,
  );
  const current = configuration ?? {
    enabled: false,
    transferEnabled: false,
    transferTargetE164: null,
    voice: 'marin',
  };

  return (
    <form action={action} className="mt-5 space-y-5">
      <label className="flex items-center gap-3 text-sm font-medium text-ink">
        <input
          defaultChecked={current.enabled}
          disabled={isPending}
          name="enabled"
          type="checkbox"
        />
        Enable inbound AI voice for this assigned number
      </label>
      <label className="block text-sm font-medium text-ink">
        AI voice
        <select
          className="mt-2 block w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm shadow-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          defaultValue={current.voice}
          disabled={isPending}
          name="voice"
        >
          {voices.map((voice) => (
            <option key={voice} value={voice}>
              {voice}
            </option>
          ))}
        </select>
      </label>
      <div className="rounded-lg border border-border p-4">
        <label className="flex items-center gap-3 text-sm font-medium text-ink">
          <input
            defaultChecked={current.transferEnabled}
            disabled={isPending}
            name="transferEnabled"
            type="checkbox"
          />
          Allow human transfer
        </label>
        <label className="mt-4 block text-sm font-medium text-ink">
          Trusted human transfer number
          <input
            className="mt-2 block w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm shadow-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            defaultValue={current.transferTargetE164 ?? ''}
            disabled={isPending}
            inputMode="tel"
            name="transferTargetE164"
            placeholder="+14155550123"
          />
        </label>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          The AI never receives this number. Transfer remains unavailable until operations confirms
          that the attached SIP trunk supports REFER.
        </p>
      </div>
      <button
        className="rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={isPending}
        type="submit"
      >
        {isPending ? 'Saving…' : 'Save voice settings'}
      </button>
      {state.status !== 'idle' ? (
        <p
          className={state.status === 'error' ? 'text-sm text-red-700' : 'text-sm text-emerald-700'}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
