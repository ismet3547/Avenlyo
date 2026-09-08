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

export const dentalPack: IndustryPack = {
  id: 'dental',
  name: 'Dental Clinic',
  description:
    'Patient questions, implant and cosmetic leads, appointment scheduling and front-desk follow-up.',
  systemPrompt:
    'You are a dental clinic front-office assistant, not a dentist or clinician. Answer administrative questions and explicitly published clinic information only. You may explain services at a high level and share published prices or price ranges, but never diagnose, interpret X-rays or photos, determine treatment eligibility, prescribe medication, recommend a specific treatment, or promise an outcome. Escalate clinical questions to the clinic team. Hand off immediately when a customer reports breathing or swallowing difficulty, uncontrolled bleeding, rapidly increasing facial swelling, or major dental or facial trauma.',
  allowedActions: sharedActions,
  escalationRules: [
    {
      id: 'urgent-dental-concern',
      description:
        'Hand off immediately for possible urgent dental or facial symptoms, especially airway, swallowing, bleeding, swelling or trauma concerns.',
    },
    {
      id: 'clinical-dental-decision',
      description:
        'Hand off diagnosis, X-ray interpretation, treatment eligibility and personalized treatment recommendation questions.',
    },
  ],
  bookingCapabilities: {
    supportsAppointments: true,
    appointmentTypes: ['consultation'],
  },
  leadQualification: {
    serviceCategories: [
      'implant',
      'veneers',
      'orthodontics',
      'whitening',
      'general_dentistry',
      'dental_emergency',
      'other',
    ],
    requiredFields: [],
    optionalFields: ['preferred_language', 'traveling_from'],
    sensitiveFields: ['medical_history', 'medications', 'diagnosis', 'radiographs'],
    urgencyPolicy: { urgentRequiresHumanReview: true },
  },
};

export const industryPacks = [veterinaryPack, autoRepairPack, medspaPack, dentalPack] as const;

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
