import type { IndustryPack } from './types';

const sharedActions = ['capture_lead', 'book_appointment', 'handoff_to_human'] as const;

export const veterinaryPack: IndustryPack = {
  id: 'veterinary',
  name: 'Veterinary Clinic',
  description: 'Appointments, client questions, pet information and front-desk communication.',
  systemPrompt:
    'You are a veterinary front-office assistant, not a clinician. Do not diagnose, recommend medication, dosage, or treatment. Administrative information is allowed. Escalate potential emergencies such as difficulty breathing, seizure, collapse, severe bleeding, possible poisoning, inability to urinate, or major trauma to a human immediately.',
  allowedActions: sharedActions,
  escalationRules: [
    {
      id: 'urgent-clinical-concern',
      description: 'Hand off immediately when a customer describes a possible animal emergency.',
    },
  ],
  bookingCapabilities: {
    supportsAppointments: true,
    appointmentTypes: ['consultation'],
  },
  leadQualification: {
    serviceCategories: ['wellness', 'vaccination', 'sick_visit', 'grooming', 'other'],
    requiredFields: [],
    optionalFields: ['pet_name', 'species'],
    sensitiveFields: [],
    urgencyPolicy: { urgentRequiresHumanReview: true },
  },
};

export const autoRepairPack: IndustryPack = {
  id: 'auto-repair',
  name: 'Auto Repair',
  description: 'Service inquiries, estimates, bookings and customer follow-up.',
  systemPrompt:
    'You are an auto-repair front-office assistant. Provide administrative and published service information, but never assure a customer that a vehicle is safe to drive. Escalate safety-critical symptoms, including brake or steering concerns, to a human.',
  allowedActions: sharedActions,
  escalationRules: [
    {
      id: 'vehicle-safety-concern',
      description:
        'Hand off when a customer reports a vehicle condition that may be unsafe to drive.',
    },
  ],
  bookingCapabilities: {
    supportsAppointments: true,
    appointmentTypes: ['service-visit'],
  },
  leadQualification: {
    serviceCategories: ['maintenance', 'repair', 'inspection', 'diagnostic', 'other'],
    requiredFields: [],
    optionalFields: ['vehicle_make', 'vehicle_model', 'vehicle_year'],
    sensitiveFields: [],
    urgencyPolicy: { urgentRequiresHumanReview: true },
  },
};

export const medspaPack: IndustryPack = {
  id: 'medspa',
  name: 'Medspa / Aesthetics',
  description: 'Treatment inquiries, lead qualification and appointment scheduling.',
  systemPrompt:
    'You are a medspa front-office assistant. Provide administrative information only. Do not diagnose, determine contraindications, or recommend medical treatments. Escalate clinical eligibility and contraindication questions to a human.',
  allowedActions: sharedActions,
  escalationRules: [
    {
      id: 'clinical-or-contraindication-question',
      description:
        'Hand off when a customer asks for clinical advice or raises a possible contraindication.',
    },
  ],
  bookingCapabilities: {
    supportsAppointments: true,
    appointmentTypes: ['consultation'],
  },
  leadQualification: {
    serviceCategories: [
      'consultation',
      'facial',
      'injectables_interest',
      'laser_or_energy',
      'skin_treatment',
      'body_contouring',
      'other',
    ],
    requiredFields: [],
    optionalFields: [],
    sensitiveFields: ['medical_history', 'contraindications'],
    urgencyPolicy: { urgentRequiresHumanReview: true },
  },
};

export const industryPacks = [veterinaryPack, autoRepairPack, medspaPack] as const;

export function resolveIndustryPack(id: string): IndustryPack | null {
  return industryPacks.find((candidate) => candidate.id === id) ?? null;
}

export function getIndustryPack(id: IndustryPack['id']): IndustryPack {
  const pack = resolveIndustryPack(id);

  if (!pack) {
    throw new Error(`Unsupported industry pack: ${id}`);
  }

  return pack;
}
