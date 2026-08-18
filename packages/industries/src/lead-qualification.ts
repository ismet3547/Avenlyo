import type { IndustryPack, LeadCustomerGoal, LeadUrgency } from './types';

export interface LeadCaptureFacts {
  readonly customerGoal?: LeadCustomerGoal;
  readonly customerName?: string;
  readonly details: Readonly<Record<string, string>>;
  readonly serviceCategory?: string;
  readonly urgency: LeadUrgency;
}

export interface ValidatedLeadCapture {
  readonly facts: LeadCaptureFacts;
  readonly missingFields: readonly string[];
  readonly qualification: 'needs_human' | 'needs_more_information' | 'qualified';
}

/** Validates only declarative business facts. It deliberately never accepts identities or state. */
export function validateLeadCapture(
  industry: IndustryPack,
  facts: LeadCaptureFacts,
): ValidatedLeadCapture {
  const allowedDetailFields = new Set([
    ...industry.leadQualification.requiredFields,
    ...industry.leadQualification.optionalFields,
  ]);
  const details = Object.fromEntries(
    Object.entries(facts.details).filter(
      ([key, value]) => allowedDetailFields.has(key) && value.trim(),
    ),
  );
  const serviceCategory = facts.serviceCategory?.trim();
  const knownCategory =
    serviceCategory !== undefined &&
    industry.leadQualification.serviceCategories.includes(serviceCategory);
  const missingFields = [
    ...(knownCategory ? [] : ['service_category']),
    ...(facts.customerGoal ? [] : ['customer_goal']),
    ...industry.leadQualification.requiredFields.filter((field) => !details[field]),
  ];
  const normalized: LeadCaptureFacts = {
    ...(facts.customerGoal ? { customerGoal: facts.customerGoal } : {}),
    ...(facts.customerName?.trim() ? { customerName: facts.customerName.trim() } : {}),
    details,
    ...(knownCategory ? { serviceCategory } : {}),
    urgency: facts.urgency,
  };
  return {
    facts: normalized,
    missingFields,
    qualification:
      facts.urgency === 'urgent' &&
      industry.leadQualification.urgencyPolicy.urgentRequiresHumanReview
        ? 'needs_human'
        : missingFields.length
          ? 'needs_more_information'
          : 'qualified',
  };
}
