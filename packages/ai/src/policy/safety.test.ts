import { autoRepairPack, dentalPack, medspaPack, veterinaryPack } from '@avenlyo/industries';
import { describe, expect, it } from 'vitest';

import { detectSafetyEscalation } from './safety';

describe('industry safety backstops', () => {
  it('routes a Turkish dental treatment decision to the clinic instead of diagnosing', () => {
    const result = detectSafetyEscalation(dentalPack, 'İmplant bana uygun mu?');

    expect(result).toMatchObject({ urgency: 'normal' });
    expect(result?.reply).toMatch(/buradan güvenle değerlendiremiyorum|klinik ekibinin|aktarıyorum/i);
    expect(result?.reply).not.toMatch(/uygun|tedavi olmalısınız/i);
  });

  it('routes severe dental symptoms urgently without inventing treatment', () => {
    const result = detectSafetyEscalation(
      dentalPack,
      'Yüzüm çok şişti ve nefes almakta zorlanıyorum.',
    );

    expect(result).toMatchObject({ urgency: 'urgent' });
    expect(result?.reply).toMatch(/^Geçmiş olsun\./);
    expect(result?.reply).toMatch(/hemen klinik ekibine aktarıyorum/i);
    expect(result?.reply).toMatch(/beklemeyin; acil yardım alın/i);
    expect(result?.reply).not.toContain('Bu durum acil değerlendirme gerektirebilir');
  });

  it('routes natural facial swelling language urgently while pain alone stays clinical', () => {
    const swollen = detectSafetyEscalation(
      dentalPack,
      'Dişim çok ağrıyor ve yüzüm şişti, ne yapmalıyım?',
    );
    const englishSwollen = detectSafetyEscalation(
      dentalPack,
      'My tooth hurts and my face is swollen. What should I do?',
    );
    const painOnly = detectSafetyEscalation(dentalPack, 'Dişim çok ağrıyor, ne yapmalıyım?');

    expect(swollen).toMatchObject({ urgency: 'urgent' });
    expect(swollen?.reply).toMatch(/^Geçmiş olsun\./);
    expect(swollen?.reply).toMatch(/acil|hemen/i);
    expect(englishSwollen).toMatchObject({ urgency: 'urgent' });
    expect(englishSwollen?.reply).toMatch(/^I’m sorry you’re dealing with that\./);
    expect(painOnly).toMatchObject({ urgency: 'normal' });
    expect(painOnly?.reply).toMatch(/buradan güvenle değerlendiremiyorum/i);
  });

  it('keeps published administrative dental questions outside the clinical backstop', () => {
    expect(detectSafetyEscalation(dentalPack, 'İmplant fiyatınız nedir?')).toBeNull();
    expect(detectSafetyEscalation(dentalPack, 'Cumartesi açık mısınız?')).toBeNull();
  });

  it('routes veterinary emergencies without providing diagnosis or dosage advice', () => {
    const result = detectSafetyEscalation(
      veterinaryPack,
      'My cat cannot breathe after taking ibuprofen.',
    );

    expect(result).toMatchObject({ urgency: 'urgent' });
    expect(result?.reply).not.toMatch(/diagnos|dosage|treatment/i);
  });

  it('routes medspa contraindication questions to a human rather than making a clinical decision', () => {
    const result = detectSafetyEscalation(
      medspaPack,
      'Am I medically suitable for this treatment?',
    );

    expect(result).toMatchObject({ urgency: 'normal' });
    expect(result?.reply).toMatch(/team|clinician/i);
  });

  it('does not assure an auto-repair customer that a vehicle is safe to drive', () => {
    const result = detectSafetyEscalation(autoRepairPack, 'My brakes failed. Is it safe to drive?');

    expect(result).toMatchObject({ urgency: 'urgent' });
    expect(result?.reply).toMatch(/can't assess|flagging/i);
  });
});
