import type { IndustryPack } from '@avenlyo/industries';

export interface SafetyEscalation {
  readonly reason: string;
  readonly reply: string;
  readonly urgency: 'normal' | 'urgent';
}

function hasAny(message: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => message.includes(phrase));
}

/**
 * Small deterministic front-office escalation backstop. It is deliberately narrow; industry packs
 * remain the source of the domain policy and the model still handles ordinary conversation.
 */
export function detectSafetyEscalation(
  industry: IndustryPack,
  userMessage: string,
): SafetyEscalation | null {
  const message = userMessage.toLocaleLowerCase('en-US');
  if (industry.id === 'veterinary') {
    if (
      hasAny(message, [
        'difficulty breathing',
        'cannot breathe',
        'seizure',
        'collapsed',
        'collapse',
        'severe bleeding',
        'ate chocolate',
        'possible poisoning',
        'poisoned',
        'unable to urinate',
        'major trauma',
        'shaking',
        'ibuprofen',
        'dosage',
      ])
    ) {
      return {
        reason: 'Potential urgent veterinary or medication safety concern.',
        reply: 'This may need urgent attention. I’m escalating this to the clinic team now.',
        urgency: 'urgent',
      };
    }
  }
  if (
    industry.id === 'medspa' &&
    hasAny(message, ['contraindication', 'medically suitable', 'safe for me', 'eligible for'])
  ) {
    return {
      reason: 'Clinical eligibility or contraindication question.',
      reply:
        'A clinician or the team needs to help with that question. I’m flagging it for them now.',
      urgency: 'normal',
    };
  }
  if (
    industry.id === 'auto-repair' &&
    hasAny(message, [
      'brake pedal goes to the floor',
      'brakes failed',
      'safe to drive',
      'can i drive',
    ])
  ) {
    return {
      reason: 'Potential vehicle safety concern.',
      reply:
        'I can’t assess whether the vehicle is safe to drive. I’m flagging this for the team now.',
      urgency: 'urgent',
    };
  }
  return null;
}
