import { describe, expect, it } from 'vitest';

import { autoRepairPack, medspaPack, veterinaryPack } from './packs';
import { requiresUrgentLeadHandoff, validateLeadCapture } from './lead-qualification';

describe('industry lead qualification', () => {
  it('qualifies a minimal veterinary appointment interest without clinical details', () => {
    expect(
      validateLeadCapture(veterinaryPack, {
        customerGoal: 'appointment',
        details: { species: 'dog' },
        serviceCategory: 'wellness',
        urgency: 'routine',
      }),
    ).toMatchObject({ missingFields: [], qualification: 'qualified' });
  });

  it('keeps auto repair leads incomplete when the customer goal is absent', () => {
    expect(
      validateLeadCapture(autoRepairPack, {
        details: { vehicle_make: 'Toyota' },
        serviceCategory: 'repair',
        urgency: 'soon',
      }),
    ).toMatchObject({ missingFields: ['customer_goal'], qualification: 'needs_more_information' });
  });

  it('does not retain medspa sensitive details and routes urgent interest to human review', () => {
    expect(
      validateLeadCapture(medspaPack, {
        customerGoal: 'service',
        details: { medical_history: 'private' },
        serviceCategory: 'facial',
        urgency: 'urgent',
      }),
    ).toMatchObject({ facts: { details: {} }, qualification: 'needs_human' });
  });

  it('derives urgent human review only from the industry pack policy', () => {
    expect(requiresUrgentLeadHandoff(veterinaryPack, 'urgent')).toBe(true);
    expect(requiresUrgentLeadHandoff(veterinaryPack, 'routine')).toBe(false);
    expect(
      requiresUrgentLeadHandoff(
        {
          ...veterinaryPack,
          leadQualification: {
            ...veterinaryPack.leadQualification,
            urgencyPolicy: { urgentRequiresHumanReview: false },
          },
        },
        'urgent',
      ),
    ).toBe(false);
  });
});
