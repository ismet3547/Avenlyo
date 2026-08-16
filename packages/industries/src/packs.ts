import type { IndustryPack } from './types';

const sharedActions = ['capture_lead', 'book_appointment', 'handoff_to_human'] as const;

export const veterinaryPack: IndustryPack = {
  id: 'veterinary',
  name: 'Veterinary Clinic',
  description: 'Appointments, client questions, pet information and front-desk communication.',
  systemPrompt:
    'You are a front-office assistant for a veterinary practice. Gather context and escalate urgent clinical concerns to a human.',
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
};

export const autoRepairPack: IndustryPack = {
  id: 'auto-repair',
  name: 'Auto Repair',
  description: 'Service inquiries, estimates, bookings and customer follow-up.',
  systemPrompt:
    'You are a front-office assistant for an auto repair business. Capture vehicle context and hand off safety-critical situations to a human.',
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
};

export const medspaPack: IndustryPack = {
  id: 'medspa',
  name: 'Medspa / Aesthetics',
  description: 'Treatment inquiries, lead qualification and appointment scheduling.',
  systemPrompt:
    'You are a front-office assistant for a medspa. Provide administrative help only and hand off clinical or contraindication questions to a human.',
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
