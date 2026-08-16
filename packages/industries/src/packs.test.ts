import { describe, expect, it } from 'vitest';

import { getIndustryPack, industryPacks, resolveIndustryPack } from './packs';
import { industrySelectionSchema } from './validation';

describe('industry packs', () => {
  it('contains the three initial industries with unique IDs', () => {
    expect(industryPacks.map((pack) => pack.id)).toEqual(['veterinary', 'auto-repair', 'medspa']);
  });

  it('retrieves a pack by ID', () => {
    expect(getIndustryPack('veterinary').name).toBe('Veterinary Clinic');
  });

  it('rejects unsupported industry identifiers at the shared boundary', () => {
    expect(industrySelectionSchema.safeParse({ industryId: 'dentistry' }).success).toBe(false);
    expect(resolveIndustryPack('dentistry')).toBeNull();
  });
});
