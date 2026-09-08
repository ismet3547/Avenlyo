import { describe, expect, it } from 'vitest';

import { getIndustryPack, industryPacks, resolveIndustryPack } from './packs';
import { industrySelectionSchema } from './validation';

describe('industry packs', () => {
  it('keeps legacy packs available and adds the dental V1 pack with a unique ID', () => {
    expect(industryPacks.map((pack) => pack.id)).toEqual([
      'veterinary',
      'auto-repair',
      'medspa',
      'dental',
    ]);
  });

  it('retrieves the dental pack by ID', () => {
    expect(getIndustryPack('dental').name).toBe('Dental Clinic');
    expect(getIndustryPack('dental').leadQualification.serviceCategories).toContain('implant');
  });

  it('accepts dental and still rejects unsupported industry identifiers', () => {
    expect(industrySelectionSchema.safeParse({ industryId: 'dental' }).success).toBe(true);
    expect(industrySelectionSchema.safeParse({ industryId: 'hospital' }).success).toBe(false);
    expect(resolveIndustryPack('hospital')).toBeNull();
  });
});
