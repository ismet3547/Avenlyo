import { describe, expect, it } from 'vitest';

import { detectExplicitHumanRequest } from './human-request';

describe('detectExplicitHumanRequest', () => {
  it.each([
    'Can I speak to a person please?',
    'I want to talk with a representative.',
    'Connect me to a human.',
    'Bir insanla konuşmak istiyorum.',
    'Beni temsilciye bağla.',
    'Canlı desteğe bağla lütfen.',
  ])('detects an unmistakable request for human assistance: %s', (message) => {
    expect(detectExplicitHumanRequest(message)).toMatchObject({
      reason: 'Customer explicitly requested human assistance.',
      urgency: 'normal',
    });
  });

  it.each([
    'Are you human?',
    'Do you have live support?',
    'What does your receptionist do?',
    'Temsilciniz var mı?',
    'İnsanlar bugün çok yoğun mu?',
  ])('does not turn a mere mention into a handoff: %s', (message) => {
    expect(detectExplicitHumanRequest(message)).toBeNull();
  });
});
