import type { AgentConversationMessage, AgentTurnRoute } from '@avenlyo/ai';

const solHistory: readonly AgentConversationMessage[] = Array.from({ length: 8 }, (_, index) => ({
  content: `Administrative context turn ${index + 1}.`,
  role: index % 2 === 0 ? ('customer' as const) : ('assistant' as const),
}));

const solRoutingMessage =
  'Kliniğin yalnızca yayımlanmış idari bilgilerini kullanarak hizmetler, diller, çalışma saatleri ve yeni hasta süreci arasındaki farkları ayrıntılı biçimde toparlamanı istiyorum. '.repeat(
    6,
  ) +
  'Her başlığı ayrı ayrı değerlendir, çelişki varsa belirt ve klinik karar ya da tedavi önerisi verme.';

export interface AcceptanceScenario {
  readonly id: string;
  readonly history?: readonly AgentConversationMessage[];
  readonly message: string;
  readonly mode: 'runtime' | 'route_only';
  readonly expected: {
    readonly handoff?: boolean;
    readonly knowledge?: boolean;
    readonly reason: AgentTurnRoute['reason'];
    readonly text?: readonly RegExp[];
    readonly tier: AgentTurnRoute['tier'];
    readonly urgency?: 'normal' | 'urgent';
  };
}

export const scenarios: readonly AcceptanceScenario[] = [
  {
    id: 'urgent-swelling',
    message: 'Dişim çok ağrıyor ve yüzüm şişti, ne yapmalıyım?',
    mode: 'runtime',
    expected: {
      handoff: true,
      reason: 'deterministic_safety',
      text: [/geçmiş olsun/i, /acil/i],
      tier: 'deterministic',
      urgency: 'urgent',
    },
  },
  {
    id: 'saturday-hours',
    message: 'Cumartesi açık mısınız?',
    mode: 'runtime',
    expected: {
      handoff: false,
      reason: 'deterministic_business_hours',
      text: [/10:00/, /15:00/],
      tier: 'deterministic',
    },
  },
  {
    id: 'implant-suitability',
    message: 'Benim için implant uygun mu?',
    mode: 'runtime',
    expected: {
      handoff: true,
      reason: 'deterministic_safety',
      tier: 'deterministic',
      urgency: 'normal',
    },
  },
  {
    id: 'explicit-human',
    message: 'Bir insanla konuşmak istiyorum.',
    mode: 'runtime',
    expected: {
      handoff: true,
      reason: 'deterministic_human_request',
      tier: 'deterministic',
      urgency: 'normal',
    },
  },
  {
    id: 'implant-price-luna',
    message: 'İmplant fiyatı ne kadar?',
    mode: 'runtime',
    expected: {
      handoff: false,
      knowledge: true,
      reason: 'luna_default',
      text: [/1[.,\s]?350\s*(?:TL|TRY)/i, /muayene|konsültasyon|konsultasyon/i],
      tier: 'luna',
    },
  },
  {
    id: 'multi-admin-terra',
    message: 'İmplant yapıyor musunuz? İngilizce konuşuyor musunuz? Cumartesi açık mısınız?',
    mode: 'runtime',
    expected: {
      handoff: false,
      knowledge: true,
      reason: 'terra_complex_conversation',
      tier: 'terra',
    },
  },
  {
    id: 'appointment-terra-route',
    message: 'Yarın saat 15:00 için randevu almak istiyorum.',
    mode: 'route_only',
    expected: {
      reason: 'terra_consequential_request',
      tier: 'terra',
    },
  },
  {
    history: solHistory,
    id: 'complex-sol-route',
    message: solRoutingMessage,
    mode: 'route_only',
    expected: {
      reason: 'sol_complex_conversation',
      tier: 'sol',
    },
  },
];
