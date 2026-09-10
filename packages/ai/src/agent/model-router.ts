import { requiresBusinessKnowledge } from './business-knowledge-predicate';
import type {
  AgentBusinessContext,
  AgentConversationMessage,
  AgentConversationWorkState,
  AgentModelCatalog,
  AgentTurnRoute,
} from './types';
import { detectExplicitHumanRequest } from '../policy/human-request';
import { detectSafetyEscalation } from '../policy/safety';
import type { IndustryPack } from '@avenlyo/industries';

export const defaultAgentModelCatalog: AgentModelCatalog = {
  luna: 'gpt-5.6-luna',
  terra: 'gpt-5.6-terra',
  sol: 'gpt-5.6-sol',
};

const weekdays = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

type Weekday = (typeof weekdays)[number];

type BusinessDay =
  | { readonly closed: true; readonly open: null; readonly close: null }
  | { readonly closed: false; readonly open: string; readonly close: string };

type BusinessHours = Readonly<Record<Weekday, BusinessDay>>;

const weekdayAliases: Readonly<Record<Weekday, readonly string[]>> = {
  monday: ['monday', 'pazartesi'],
  tuesday: ['tuesday', 'salı', 'sali'],
  wednesday: ['wednesday', 'çarşamba', 'carsamba'],
  thursday: ['thursday', 'perşembe', 'persembe'],
  friday: ['friday', 'cuma'],
  saturday: ['saturday', 'cumartesi'],
  sunday: ['sunday', 'pazar'],
};

const weekdayLabels = {
  en: {
    monday: 'Monday',
    tuesday: 'Tuesday',
    wednesday: 'Wednesday',
    thursday: 'Thursday',
    friday: 'Friday',
    saturday: 'Saturday',
    sunday: 'Sunday',
  },
  tr: {
    monday: 'Pazartesi',
    tuesday: 'Salı',
    wednesday: 'Çarşamba',
    thursday: 'Perşembe',
    friday: 'Cuma',
    saturday: 'Cumartesi',
    sunday: 'Pazar',
  },
} as const;

function normalized(message: string): string {
  return message
    .toLocaleLowerCase('en-US')
    .normalize('NFKC')
    .replace(/\u0307/g, '');
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function parseBusinessHours(value: string | null): BusinessHours | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const result = {} as Record<Weekday, BusinessDay>;
    for (const weekday of weekdays) {
      const candidate = record[weekday];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
      const day = candidate as Record<string, unknown>;
      if (day.closed === true && day.open === null && day.close === null) {
        result[weekday] = { closed: true, open: null, close: null };
        continue;
      }
      if (day.closed === false && isTime(day.open) && isTime(day.close) && day.open < day.close) {
        result[weekday] = { closed: false, open: day.open, close: day.close };
        continue;
      }
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

function isTurkish(message: string): boolean {
  const lower = normalized(message);
  return (
    /[çğıöşü]/i.test(message) ||
    [
      'pazartesi',
      'sali',
      'salı',
      'çarşamba',
      'carsamba',
      'perşembe',
      'persembe',
      'cuma',
      'cumartesi',
      'pazar',
      'açık',
      'kapalı',
      'saat',
    ].some((word) => lower.includes(word))
  );
}

function containsWord(message: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}])${escaped}(?:$|[^\\p{L}])`, 'u').test(message);
}

function requestedWeekday(message: string): Weekday | null {
  const lower = normalized(message);
  return (
    weekdays.find((weekday) =>
      weekdayAliases[weekday].some((alias) => containsWord(lower, alias)),
    ) ?? null
  );
}

function isBusinessHoursQuestion(message: string): boolean {
  const lower = normalized(message);
  const weekday = requestedWeekday(message);
  if (weekday) {
    return hasAny(lower, ['open', 'closed', 'close', 'hours', 'açık', 'kapalı', 'saat', 'kaçta']);
  }
  return hasAny(lower, [
    'opening hours',
    'business hours',
    'what are your hours',
    'when are you open',
    'çalışma saat',
    'calisma saat',
    'kaçta aç',
    'kacta ac',
    'kaçta kapa',
    'kacta kapa',
  ]);
}

function hasAny(message: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => message.includes(phrase));
}

function businessHoursReply(message: string, business: AgentBusinessContext): string | null {
  if (!isBusinessHoursQuestion(message)) return null;
  // Mixed requests such as “Are you open Saturday and do you offer implants?” still need the
  // knowledge path for the residual business-specific clause. Never truncate a multi-intent turn.
  if (requiresBusinessKnowledge(message, business)) return null;
  const hours = parseBusinessHours(business.businessHours);
  if (!hours) return null;

  const language = isTurkish(message) ? 'tr' : 'en';
  const weekday = requestedWeekday(message);
  if (weekday) {
    const day = hours[weekday];
    const label = weekdayLabels[language][weekday];
    if (day.closed)
      return language === 'tr' ? `${label} günleri kapalıyız.` : `We are closed on ${label}.`;
    return language === 'tr'
      ? `${label} günleri ${day.open}–${day.close} arasında açığız.`
      : `We are open on ${label} from ${day.open} to ${day.close}.`;
  }

  const parts = weekdays.map((day) => {
    const value = hours[day];
    const label = weekdayLabels[language][day];
    if (value.closed) return language === 'tr' ? `${label}: kapalı` : `${label}: closed`;
    return `${label}: ${value.open}–${value.close}`;
  });
  return language === 'tr'
    ? `Çalışma saatlerimiz: ${parts.join('; ')}.`
    : `Our opening hours are: ${parts.join('; ')}.`;
}

function modelCatalog(models?: Partial<AgentModelCatalog>): AgentModelCatalog {
  return { ...defaultAgentModelCatalog, ...models };
}

function clauseCount(message: string): number {
  return normalized(message)
    .split(/(?:[?!.;]|\b(?:and|but|also|then|ve|ama|ayrıca|sonra)\b)/u)
    .filter((part) => part.trim().length >= 3).length;
}

function looksConsequential(message: string): boolean {
  const lower = normalized(message);
  return hasAny(lower, [
    'appointment',
    'book',
    'booking',
    'schedule',
    'reschedule',
    'cancel',
    'randevu',
    'rezervasyon',
    'iptal',
    'ertele',
  ]);
}

function looksLikeCorrection(message: string): boolean {
  const lower = normalized(message);
  return hasAny(lower, [
    'actually',
    'instead',
    'change that',
    'correction',
    'wait',
    'aslında',
    'yerine',
    'değiştir',
    'vazgeçtim',
    'pardon',
  ]);
}

export function routeAgentTurn(input: {
  readonly business: AgentBusinessContext;
  readonly history: readonly AgentConversationMessage[];
  readonly industry: IndustryPack;
  readonly models?: Partial<AgentModelCatalog>;
  readonly userMessage: string;
  readonly workState?: AgentConversationWorkState | undefined;
}): AgentTurnRoute {
  const safety = detectSafetyEscalation(input.industry, input.userMessage);
  if (safety) {
    return {
      action: {
        handoffReason: safety.reason,
        kind: 'handoff',
        text: safety.reply,
        urgency: safety.urgency,
      },
      kind: 'deterministic',
      model: 'deterministic',
      reason: 'deterministic_safety',
      reasoningEffort: 'none',
      tier: 'deterministic',
    };
  }

  const human = detectExplicitHumanRequest(input.userMessage);
  if (human) {
    return {
      action: {
        handoffReason: human.reason,
        kind: 'handoff',
        text: human.reply,
        urgency: human.urgency,
      },
      kind: 'deterministic',
      model: 'deterministic',
      reason: 'deterministic_human_request',
      reasoningEffort: 'none',
      tier: 'deterministic',
    };
  }

  const directBusinessReply = businessHoursReply(input.userMessage, input.business);
  if (directBusinessReply) {
    return {
      action: { kind: 'reply', text: directBusinessReply },
      kind: 'deterministic',
      model: 'deterministic',
      reason: 'deterministic_business_hours',
      reasoningEffort: 'none',
      tier: 'deterministic',
    };
  }

  const models = modelCatalog(input.models);
  const messageLength = input.userMessage.trim().length;
  const deepHistory = input.history.length >= 8;
  const multiClause = clauseCount(input.userMessage) >= 3;
  const pendingMutation = Boolean(input.workState?.pendingMutation);
  const consequential = looksConsequential(input.userMessage);
  const correction = looksLikeCorrection(input.userMessage);

  if (
    (deepHistory && messageLength >= 700) ||
    (pendingMutation && deepHistory && (multiClause || correction)) ||
    (messageLength >= 1_200 && multiClause)
  ) {
    return {
      kind: 'model',
      model: models.sol,
      reason: 'sol_complex_conversation',
      reasoningEffort: 'medium',
      tier: 'sol',
    };
  }

  if (pendingMutation) {
    return {
      kind: 'model',
      model: models.terra,
      reason: 'terra_pending_mutation',
      reasoningEffort: 'low',
      tier: 'terra',
    };
  }
  if (consequential) {
    return {
      kind: 'model',
      model: models.terra,
      reason: 'terra_consequential_request',
      reasoningEffort: 'low',
      tier: 'terra',
    };
  }
  if (input.history.length >= 6 || messageLength >= 500 || multiClause) {
    return {
      kind: 'model',
      model: models.terra,
      reason: 'terra_complex_conversation',
      reasoningEffort: 'low',
      tier: 'terra',
    };
  }
  return {
    kind: 'model',
    model: models.luna,
    reason: 'luna_default',
    reasoningEffort: 'none',
    tier: 'luna',
  };
}

export function fixedModelCatalog(model: string): AgentModelCatalog {
  return { luna: model, terra: model, sol: model };
}
