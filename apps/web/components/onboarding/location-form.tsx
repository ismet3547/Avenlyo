'use client';

import { type BusinessHours, type Weekday, weekdays } from '@avenlyo/shared';
import { useActionState, useState } from 'react';

import { saveLocationAction } from '@/app/onboarding/actions';
import { initialFormActionState } from '@/lib/forms/state';

import { FieldError, FormMessage } from './form-feedback';
import { SubmitButton } from './submit-button';

const openHours = { closed: false as const, open: '09:00', close: '17:00' };
const closedHours = { closed: true as const, open: null, close: null };

const defaultBusinessHours: BusinessHours = {
  monday: openHours,
  tuesday: openHours,
  wednesday: openHours,
  thursday: openHours,
  friday: openHours,
  saturday: closedHours,
  sunday: closedHours,
};

const timezoneSuggestions = [
  'Africa/Johannesburg',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/New_York',
  'Asia/Dubai',
  'Asia/Singapore',
  'Australia/Sydney',
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Paris',
];

interface LocationFormProps {
  initialAddress: {
    city?: string | undefined;
    countryCode?: string | undefined;
    postalCode?: string | undefined;
    region?: string | undefined;
    street?: string | undefined;
  };
  initialBusinessHours: BusinessHours | null;
  initialName: string | null;
  initialTimezone: string | null;
}

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function LocationForm({
  initialAddress,
  initialBusinessHours,
  initialName,
  initialTimezone,
}: LocationFormProps) {
  const [state, action] = useActionState(saveLocationAction, initialFormActionState);
  const [hours, setHours] = useState<BusinessHours>(initialBusinessHours ?? defaultBusinessHours);

  function setClosed(day: Weekday, closed: boolean) {
    setHours((current) => ({
      ...current,
      [day]: closed ? closedHours : openHours,
    }));
  }

  function setTime(day: Weekday, field: 'open' | 'close', value: string) {
    setHours((current) => {
      const existing = current[day];
      const active = existing.closed ? openHours : existing;
      return { ...current, [day]: { ...active, [field]: value } };
    });
  }

  return (
    <form action={action} className="mt-9 space-y-8" noValidate>
      <input name="businessHours" type="hidden" value={JSON.stringify(hours)} />

      <div>
        <label className="text-sm font-semibold text-ink" htmlFor="name">
          Location name
        </label>
        <input
          className="avenlyo-input mt-2"
          defaultValue={initialName ?? 'Main location'}
          id="name"
          name="name"
          placeholder="Main location"
          required
        />
        <FieldError errors={state.fieldErrors?.name} />
      </div>

      <fieldset>
        <legend className="text-sm font-semibold text-ink">Address</legend>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="sr-only" htmlFor="street">
              Street address
            </label>
            <input
              autoComplete="street-address"
              className="avenlyo-input"
              defaultValue={initialAddress.street ?? ''}
              id="street"
              name="street"
              placeholder="Street address"
              required
            />
            <FieldError errors={state.fieldErrors?.street} />
          </div>
          <div>
            <label className="sr-only" htmlFor="city">
              City
            </label>
            <input
              autoComplete="address-level2"
              className="avenlyo-input"
              defaultValue={initialAddress.city ?? ''}
              id="city"
              name="city"
              placeholder="City"
              required
            />
            <FieldError errors={state.fieldErrors?.city} />
          </div>
          <div>
            <label className="sr-only" htmlFor="region">
              State or region
            </label>
            <input
              autoComplete="address-level1"
              className="avenlyo-input"
              defaultValue={initialAddress.region ?? ''}
              id="region"
              name="region"
              placeholder="State or region"
              required
            />
            <FieldError errors={state.fieldErrors?.region} />
          </div>
          <div>
            <label className="sr-only" htmlFor="postalCode">
              Postal code
            </label>
            <input
              autoComplete="postal-code"
              className="avenlyo-input"
              defaultValue={initialAddress.postalCode ?? ''}
              id="postalCode"
              name="postalCode"
              placeholder="Postal code"
              required
            />
            <FieldError errors={state.fieldErrors?.postalCode} />
          </div>
          <div>
            <label className="sr-only" htmlFor="countryCode">
              Country code
            </label>
            <input
              autoCapitalize="characters"
              autoComplete="country"
              className="avenlyo-input uppercase"
              defaultValue={initialAddress.countryCode ?? ''}
              id="countryCode"
              maxLength={2}
              name="countryCode"
              placeholder="Country code (TR)"
              required
            />
            <FieldError errors={state.fieldErrors?.countryCode} />
          </div>
        </div>
      </fieldset>

      <div>
        <label className="text-sm font-semibold text-ink" htmlFor="timezone">
          Timezone
        </label>
        <input
          className="avenlyo-input mt-2"
          defaultValue={initialTimezone === 'UTC' ? '' : (initialTimezone ?? '')}
          id="timezone"
          list="timezone-suggestions"
          name="timezone"
          placeholder="Europe/Istanbul"
          required
        />
        <datalist id="timezone-suggestions">
          {timezoneSuggestions.map((timezone) => (
            <option key={timezone} value={timezone} />
          ))}
        </datalist>
        <p className="mt-2 text-xs text-muted-foreground">
          Use an IANA timezone such as Europe/Istanbul or America/New_York.
        </p>
        <FieldError errors={state.fieldErrors?.timezone} />
      </div>

      <fieldset>
        <legend className="text-sm font-semibold text-ink">Business hours</legend>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Overnight hours are not supported during initial setup.
        </p>
        <div className="mt-4 divide-y divide-slate-100 rounded-2xl border border-slate-200 px-4">
          {weekdays.map((day) => {
            const value = hours[day];
            return (
              <div
                className="grid gap-3 py-3 sm:grid-cols-[7rem_1fr_auto] sm:items-center"
                key={day}
              >
                <span className="text-sm font-medium text-ink">{titleCase(day)}</span>
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`${titleCase(day)} opening time`}
                    className="h-9 min-w-0 rounded-lg border border-input px-2 text-sm disabled:bg-slate-50 disabled:text-slate-400"
                    disabled={value.closed}
                    onChange={(event) => setTime(day, 'open', event.currentTarget.value)}
                    type="time"
                    value={value.closed ? '09:00' : value.open}
                  />
                  <span className="text-xs text-slate-400">to</span>
                  <input
                    aria-label={`${titleCase(day)} closing time`}
                    className="h-9 min-w-0 rounded-lg border border-input px-2 text-sm disabled:bg-slate-50 disabled:text-slate-400"
                    disabled={value.closed}
                    onChange={(event) => setTime(day, 'close', event.currentTarget.value)}
                    type="time"
                    value={value.closed ? '17:00' : value.close}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <input
                    checked={value.closed}
                    className="size-4 rounded border-slate-300 text-primary focus:ring-primary"
                    onChange={(event) => setClosed(day, event.currentTarget.checked)}
                    type="checkbox"
                  />
                  Closed
                </label>
              </div>
            );
          })}
        </div>
        <FieldError errors={state.fieldErrors?.businessHours} />
      </fieldset>

      <FormMessage state={state} />
      <div className="flex justify-end border-t border-slate-100 pt-6">
        <SubmitButton label="Continue to website" />
      </div>
    </form>
  );
}
