export const industryIds = ['veterinary', 'auto-repair', 'medspa'] as const;

export type IndustryId = (typeof industryIds)[number];

export type AgentAction = 'capture_lead' | 'book_appointment' | 'handoff_to_human';

export interface EscalationRule {
  id: string;
  description: string;
}

export interface BookingCapabilities {
  supportsAppointments: boolean;
  appointmentTypes: readonly string[];
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
}
