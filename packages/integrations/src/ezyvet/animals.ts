import type { ExternalCustomer, SubjectResolution } from '../scheduling/types';

import { boolean, items, record, string } from './schemas';
import type { EzyVetClient } from './client';

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export async function resolveOwnedAnimal(
  client: EzyVetClient,
  customer: ExternalCustomer,
  petName: string,
): Promise<SubjectResolution> {
  const desiredName = normalizedName(petName);
  if (desiredName.length === 0 || desiredName.length > 80) return { kind: 'unresolved' };
  const payload = await client.getCore('/v4/animal', {
    isDead: 'false',
    name: petName.trim(),
    ownerId: customer.key,
    status: 'active',
  });
  const matches = new Map<string, { readonly displayName: string; readonly key: string }>();
  for (const item of items(payload)) {
    const animal = record(record(item).animal ?? record(item).attributes ?? item);
    if (
      boolean(animal.active) === false ||
      boolean(animal.isDead ?? animal.is_dead ?? animal.deceased) === true
    )
      continue;
    if (string(animal.status)?.toLowerCase() !== 'active') continue;
    const owner = string(
      animal.ownerId ?? animal.owner_id ?? animal.contact_uid ?? animal.contactUid,
    );
    const name = string(animal.name);
    const key = string(animal.uid ?? animal.id);
    if (!owner || owner !== customer.key || !name || !key || normalizedName(name) !== desiredName)
      continue;
    matches.set(key, { displayName: name, key });
  }
  const values = [...matches.values()];
  if (values.length === 0) return { kind: 'unresolved' };
  return values.length === 1 ? { kind: 'resolved', subject: values[0]! } : { kind: 'ambiguous' };
}
