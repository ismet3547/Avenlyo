import { describe, expect, it } from 'vitest';

import { getIndustryPack, industryPacks } from './packs';

describe('industry packs', () => {
  it('contains the three initial industries with unique IDs', () => {
    expect(industryPacks.map((pack) => pack.id)).toEqual(['veterinary', 'auto-repair', 'medspa']);
  });

  it('retrieves a pack by ID', () => {
    expect(getIndustryPack('veterinary').name).toBe('Veterinary');
  });
});
