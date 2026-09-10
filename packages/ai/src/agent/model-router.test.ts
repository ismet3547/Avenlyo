import { dentalPack } from '@avenlyo/industries';
import { describe, expect, it } from 'vitest';

import { routeAgentTurn } from './model-router';
import type { AgentBusinessContext, AgentConversationMessage } from './types';

const business: AgentBusinessContext = {
  address: 'Kadikoy, Istanbul',
  businessHours: JSON.stringify({
    monday: { closed: false, open: '09:00', close: '18:00' },
    tuesday: { closed: false, open: '09:00', close: '18:00' },
    wednesday: { closed: false, open: '09:00', close: '18:00' },
    thursday: { closed: false, open: '09:00', close: '18:00' },
    friday: { closed: false, open: '09:00', close: '18:00' },
    saturday: { closed: false, open: '10:00', close: '15:00' },
    sunday: { closed: true, open: null, close: null },
  }),
  locationName: 'Istanbul Main Clinic',
  name: 'Avenlyo Dental Demo Clinic',
  phone: null,
  timezone: 'Europe/Istanbul',
  website: null,
};

const history = (count: number): AgentConversationMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    content: `Message ${index}`,
    role: index % 2 ? ('assistant' as const) : ('customer' as const),
  }));

function route(userMessage: string, previous = history(0)) {
  return routeAgentTurn({ business, history: previous, industry: dentalPack, userMessage });
}

describe('cost-aware agent model router', () => {
  it('keeps urgent dental safety entirely outside the model path', () => {
    const result = route('Dişim çok ağrıyor ve yüzüm şişti, ne yapmalıyım?');

    expect(result).toMatchObject({
      kind: 'deterministic',
      model: 'deterministic',
      reason: 'deterministic_safety',
      tier: 'deterministic',
    });
    expect(result.kind === 'deterministic' ? result.action : null).toMatchObject({
      kind: 'handoff',
      urgency: 'urgent',
    });
  });

  it('answers a pure weekday-hours question from authoritative configuration with zero model work', () => {
    const result = route('Cumartesi açık mısınız?');

    expect(result).toMatchObject({
      kind: 'deterministic',
      reason: 'deterministic_business_hours',
      tier: 'deterministic',
    });
    expect(result.kind === 'deterministic' ? result.action : null).toEqual({
      kind: 'reply',
      text: 'Cumartesi günleri 10:00–15:00 arasında açığız.',
    });
  });

  it('does not truncate mixed hours plus service questions into a deterministic hours-only answer', () => {
    const result = route('Cumartesi açık mısınız ve implant yapıyor musunuz?');
    expect(result.kind).toBe('model');
  });

  it('uses Luna by default for ordinary receptionist questions', () => {
    expect(route('İngilizce konuşuyor musunuz?')).toMatchObject({
      kind: 'model',
      model: 'gpt-5.6-luna',
      reason: 'luna_default',
      reasoningEffort: 'none',
      tier: 'luna',
    });
  });

  it('uses Terra for consequential appointment requests, including Turkish inflections', () => {
    for (const message of [
      'Yarın saat 15:00 için randevu almak istiyorum.',
      'Randevumu 17:00’ye al.',
      'Vazgeçtim, iptal et.',
    ]) {
      expect(route(message)).toMatchObject({
        kind: 'model',
        model: 'gpt-5.6-terra',
        reason: 'terra_consequential_request',
        reasoningEffort: 'low',
        tier: 'terra',
      });
    }
  });

  it('uses Sol only for deep, genuinely complex conversations', () => {
    const result = routeAgentTurn({
      business,
      history: history(10),
      industry: dentalPack,
      userMessage: `${'Detaylı açıklamam var. '.repeat(38)} Aslında önceki randevuyu değiştirmek istiyorum ama önce seçenekleri açıklar mısınız?`,
      workState: {
        control: 'ai_active',
        pendingMutation: { actionIntentId: 'intent-1', intent: 'APPOINTMENT_RESCHEDULE' },
      },
    });

    expect(result).toMatchObject({
      kind: 'model',
      model: 'gpt-5.6-sol',
      reason: 'sol_complex_conversation',
      reasoningEffort: 'medium',
      tier: 'sol',
    });
  });

  it('allows deployment-specific model ids without changing routing policy', () => {
    const result = routeAgentTurn({
      business,
      history: [],
      industry: dentalPack,
      models: { luna: 'cheap-model', terra: 'mid-model', sol: 'strong-model' },
      userMessage: 'Merhaba, bir sorum var.',
    });
    expect(result).toMatchObject({ kind: 'model', model: 'cheap-model', tier: 'luna' });
  });
});
