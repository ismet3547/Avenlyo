'use client';

import { useState } from 'react';

import type { LeadFollowupSenderOptionRow } from '@/lib/followups/service';

interface SenderAcknowledgementProps {
  readonly acknowledged: boolean;
  readonly disabled: boolean;
  readonly options: readonly LeadFollowupSenderOptionRow[];
  readonly selectedSenderId: string | null;
}

/** Resets the explicit acknowledgement when an owner selects a different sender. */
export function SenderAcknowledgement({
  acknowledged,
  disabled,
  options,
  selectedSenderId,
}: SenderAcknowledgementProps) {
  const [senderId, setSenderId] = useState(selectedSenderId ?? '');
  const [isAcknowledged, setIsAcknowledged] = useState(acknowledged);

  return (
    <>
      <label className="grid gap-2 text-sm font-medium text-ink">
        SMS sender
        <select
          className="rounded-md border border-input bg-white px-3 py-2"
          disabled={disabled}
          name="senderPhoneNumberId"
          onChange={(event) => {
            setSenderId(event.target.value);
            setIsAcknowledged(false);
          }}
          value={senderId}
        >
          <option value="">Select an active business number</option>
          {options.map((sender) => (
            <option key={sender.phone_number_id} value={sender.phone_number_id}>
              {sender.phone_number}
            </option>
          ))}
        </select>
        <span className="text-xs font-normal leading-5 text-muted-foreground">
          Follow-ups use only this exact active SMS number. Changing it suppresses unsent
          follow-ups and requires a new acknowledgement.
        </span>
      </label>
      <label className="flex items-start gap-3 border-t border-border pt-5 text-sm">
        <input
          checked={isAcknowledged}
          className="mt-1 size-4 accent-primary"
          disabled={disabled || !senderId}
          name="acknowledgeSender"
          onChange={(event) => setIsAcknowledged(event.target.checked)}
          type="checkbox"
        />
        <span>
          <strong className="font-semibold text-ink">Confirm sender authorization</strong>
          <br />
          <span className="text-muted-foreground">
            I confirm that the selected SMS sender, use case, and consent flow are authorized for
            these messages.
          </span>
        </span>
      </label>
    </>
  );
}
