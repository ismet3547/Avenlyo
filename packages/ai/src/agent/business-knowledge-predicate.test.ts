import { describe, expect, it } from 'vitest';

import { requiresBusinessKnowledge } from './business-knowledge-predicate';
import type { AgentBusinessContext } from './types';

const configured: AgentBusinessContext = {
  address: '1 Clinic Street, Istanbul',
  businessHours: '{"saturday":{"open":"10:00","close":"15:00","closed":false}}',
  locationName: 'Istanbul Main Clinic',
  name: 'Avenlyo Dental Demo Clinic',
  phone: null,
  timezone: 'Europe/Istanbul',
  website: null,
};

const withoutHours: AgentBusinessContext = { ...configured, businessHours: null };

describe('weekday business-hours grounding', () => {
  const configurationOnly = [
    'Cumartesi açık mısınız?',
    'Cumartesi günü açık mısınız?',
    'Cumartesi acik misiniz?',
    'Are you open on Saturday?',
    'Are you open Saturday?',
  ];

  for (const message of configurationOnly) {
    it(`uses configured hours for ${JSON.stringify(message)}`, () => {
      expect(requiresBusinessKnowledge(message, configured)).toBe(false);
      expect(requiresBusinessKnowledge(message, withoutHours)).toBe(true);
    });
  }

  const mixedBusinessQuestions = [
    'Cumartesi açık mısınız ve implant yapıyor musunuz?',
    'Are you open on Saturday and do you offer implants?',
  ];

  for (const message of mixedBusinessQuestions) {
    it(`still grounds residual business facts in ${JSON.stringify(message)}`, () => {
      expect(requiresBusinessKnowledge(message, configured)).toBe(true);
    });
  }
});
