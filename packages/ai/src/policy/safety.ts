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
  const message = userMessage
    .toLocaleLowerCase('en-US')
    .normalize('NFKC')
    .replace(/\u0307/g, '');
  if (industry.id === 'dental') {
    const turkish =
      /[çğıöşü]/i.test(userMessage) ||
      hasAny(message, ['diş', 'implant bana', 'implant için', 'röntgen', 'kanama', 'yüzüm']);
    if (
      hasAny(message, [
        'difficulty breathing',
        'cannot breathe',
        "can't breathe",
        'difficulty swallowing',
        'cannot swallow',
        "can't swallow",
        'uncontrolled bleeding',
        'bleeding will not stop',
        "bleeding won't stop",
        'rapid facial swelling',
        'face is swelling',
        'major facial trauma',
        'knocked out tooth',
        'tooth knocked out',
        'nefes alamıyorum',
        'nefes almakta zorlanıyorum',
        'yutkunamıyorum',
        'yutmakta zorlanıyorum',
        'kanama durmuyor',
        'şiddetli kanama',
        'yüzüm hızla şişiyor',
        'yüzüm çok şişti',
        'dişim yerinden çıktı',
      ])
    ) {
      return {
        reason: 'Potential urgent dental or facial safety concern.',
        reply: turkish
          ? 'Bu durum acil değerlendirme gerektirebilir. Klinik ekibine hemen yönlendiriyorum. Nefes alma veya yutma güçlüğü varsa yerel acil sağlık hizmetlerine başvurun.'
          : 'This may need urgent clinical attention. I’m escalating this to the clinic team now. If breathing or swallowing is affected, contact local emergency services.',
        urgency: 'urgent',
      };
    }
    if (
      hasAny(message, [
        'toothache',
        'severe tooth pain',
        'my tooth hurts',
        'what treatment do i need',
        'do i need a root canal',
        'do i need a filling',
        'am i suitable for an implant',
        'implant suitable for me',
        'should i get an implant',
        'diagnose',
        'x-ray',
        'radiograph',
        'dişim ağrıyor',
        'dişim çok ağrıyor',
        'hangi tedaviye ihtiyacım var',
        'kanal tedavisi gerekir mi',
        'dolgu gerekir mi',
        'implant bana uygun mu',
        'implant için uygun muyum',
        'röntgen',
        'teşhis',
      ])
    ) {
      return {
        reason: 'Dental diagnosis, treatment eligibility or clinical advice question.',
        reply: turkish
          ? 'Bunu güvenli şekilde değerlendirmek için klinik ekibinin yardımcı olması gerekiyor. Sizi şimdi ekibe yönlendiriyorum.'
          : 'The clinic team needs to help with that clinical question. I’m handing this over to them now.',
        urgency: 'normal',
      };
    }
  }
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
