import type { CustomerResolution, ExternalCustomer } from '../scheduling/types';

import { array, boolean, items, record, string } from './schemas';
import type { EzyVetClient } from './client';

function normalizedDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function contactFromDetail(value: unknown, expectedDigits: string): ExternalCustomer | null {
  const detail = record(record(value).contactdetail ?? record(value).contactDetail ?? value);
  if (boolean(detail.active) === false) return null;
  const cleaned = string(detail.value_cleaned ?? detail.valueCleaned ?? detail.value);
  const key = string(detail.contact_uid ?? detail.contactUid ?? detail.contact_id);
  if (!cleaned || !key || normalizedDigits(cleaned) !== expectedDigits) return null;
  return { displayName: string(detail.contact_name ?? detail.contactName), key };
}

export async function resolveExactPhoneCustomer(
  client: EzyVetClient,
  trustedCallerE164: string,
): Promise<CustomerResolution> {
  const digits = normalizedDigits(trustedCallerE164);
  if (digits.length < 8 || digits.length > 15) return { kind: 'unresolved' };
  const payload = await client.get('/v2/contactdetail', {
    'filter[value_cleaned][eq]': digits,
  });
  const candidates = new Map<string, ExternalCustomer>();
  for (const item of items(payload)) {
    const contact = contactFromDetail(item, digits);
    if (contact) candidates.set(contact.key, contact);
  }
  const resolved = [...candidates.values()];
  if (resolved.length === 0) return { kind: 'unresolved' };
  return resolved.length === 1
    ? { customer: resolved[0]!, kind: 'resolved' }
    : { kind: 'ambiguous' };
}

export function contactDetailValues(value: unknown): readonly unknown[] {
  return array(record(value).items ?? record(value).data);
}
