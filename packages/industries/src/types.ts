export const industryIds = ['veterinary', 'auto-repair', 'medspa'] as const;

export type IndustryId = (typeof industryIds)[number];

export function isIndustryId(value: unknown): value is IndustryId {
  return typeof value === 'string' && industryIds.some((industryId) => industryId === value);
}

export type AgentAction = 'capture_lead' | 'book_appointment' | 'handoff_to_human';

export interface EscalationRule {
  id: string;
  description: string;
}

export interface BookingCapabilities {
  supportsAppointments: boolean;
  appointmentTypes: readonly string[];
}

export type LeadUrgency = 'routine' | 'soon' | 'urgent' | 'unknown';
export type LeadCustomerGoal = 'appointment' | 'estimate' | 'information' | 'service';

/** Declarative lead facts keep industry requirements out of transports and persistence. */
export interface LeadQualification {
  readonly serviceCategories: readonly string[];
  readonly requiredFields: readonly string[];
  readonly optionalFields: readonly string[];
  readonly sensitiveFields: readonly string[];
  readonly urgencyPolicy: { readonly urgentRequiresHumanReview: boolean };
}

/**
 * A declarative domain boundary for AI Front Office behaviour. Runtime implementations consume
 * packs; they should not spread industry conditionals across routes or services.
 */
export interface IndustryPack {
  id: IndustryId;
  name: string;
  description: string;
  systemPrompt: string;
  allowedActions: readonly AgentAction[];
  escalationRules: readonly EscalationRule[];
  bookingCapabilities: BookingCapabilities;
  leadQualification: LeadQualification;
}
