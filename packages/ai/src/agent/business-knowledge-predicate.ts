import type { AgentBusinessContext } from './types';

/**
 * Whether a customer turn is asking for a fact only the business's own published knowledge can
 * answer.
 *
 * This exists because staging caught the model skipping the knowledge tool entirely and then
 * asserting a business-specific fact anyway -- "there is no registration link" -- about a site
 * whose registration page had been published minutes earlier. The prompt already told it to
 * search. An instruction the model can decline is not a control, and the runtime's no-knowledge
 * guard only arms once a search has been attempted, so declining to search bypassed it entirely.
 *
 * Deliberately not a model call. A classifier that can be wrong in novel ways, on the path whose
 * whole job is to stop the model being wrong in novel ways, is not a safety mechanism.
 *
 * ## Fail closed, and mean it
 *
 * The default is that a turn requires grounding. Three narrow categories are exempt. That is
 * affordable because this only runs when the model tried to end a turn with no tool call at all: a
 * broader guard costs one extra search on that path, a narrower one costs an ungrounded claim
 * about someone's business.
 *
 * The exemptions have to be genuinely narrow, and an earlier version's were not:
 *
 * - It exempted "Adresiniz neresi?" without knowing whether an address was configured. With
 *   `business.address` null there is no authoritative answer anywhere, so the exemption handed the
 *   turn straight back to the model to invent one. An exemption that does not check the value is
 *   not an exemption, it is the original hole with extra steps. The predicate therefore takes the
 *   trusted business context and requires the field to actually be present.
 *
 * - It treated "contains a configuration word and no known counter-word" as a whole-turn test.
 *   "Kaçta botoks yapıyorsunuz?" and "Adresinizde otopark bulunuyor mu?" both sailed through. The
 *   fix is not another counter-word list -- that list is as unfinishable as the service catalogue
 *   it already replaced. Configuration questions are now matched as *whole turns* against anchored
 *   shapes, so a question that merely starts like one does not qualify.
 *
 * - It treated any co-occurrence of an appointment noun and an action word as a scheduling action,
 *   so "Randevu almak için hangi belgeler gerekiyor?" was exempted as if it were a booking. Asking
 *   what is required in order to book is a question about the business. The exemption now needs
 *   explicit first-person intent or an imperative, and stands down when the turn asks about
 *   requirements, process, or price.
 *
 * Missing a genuine action phrase costs a wasted search. Accepting an ungrounded factual answer
 * costs a customer being told something untrue about a business. Those are not comparable, and
 * every ambiguous case here is resolved toward the search.
 */

/**
 * Casefold for comparison.
 *
 * The combining-dot removal is not cosmetic: JavaScript lowercases Turkish "İ" to "i" plus
 * U+0307, so "İptal" becomes "i̇ptal" and never matches a plain "iptal". Stripping the mark makes
 * the two forms comparable without pulling in locale-dependent casing.
 */
function normalize(message: string): string {
  return message
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/̇/g, '');
}

/**
 * Matches a term at the start of a word.
 *
 * Word-initial rather than anywhere, so a short term cannot fire from inside an unrelated word, and
 * rather than whole-word, so Turkish suffixes still match: "randevumu" starts a word with
 * "randevu".
 */
function mentions(normalized: string, term: string): boolean {
  let index = normalized.indexOf(term);
  while (index !== -1) {
    if (index === 0 || !/\p{L}|\p{N}/u.test(normalized.charAt(index - 1))) return true;
    index = normalized.indexOf(term, index + 1);
  }
  return false;
}

function mentionsAny(normalized: string, terms: readonly string[]): boolean {
  return terms.some((term) => mentions(normalized, term));
}

function isPresent(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Words carrying no enquiry of their own, so "çok teşekkürler" is still just thanks. */
const CONVERSATION_FILLER = '(?:çok|cok|very|so|really|much|ve|and|bir|de|da|lütfen|lutfen|please)';

const CONVERSATION_GREETING =
  '(?:merhaba|selam\\p{L}*|günaydın|gunaydin|iyi günler|iyi gunler|iyi akşamlar|iyi aksamlar|nasıls\\p{L}*|nasils\\p{L}*|teşekkür\\p{L}*|tesekkur\\p{L}*|sağ ol\\p{L}*|sag ol\\p{L}*|eyvallah|rica ederim|tamam\\p{L}*|peki|olur|anladım|anladim|görüşürüz|gorusuruz|hoşça kal\\p{L}*|hosca kal\\p{L}*|yardımcı olabilir misin\\p{L}*|yardimci olabilir misin\\p{L}*|hello|hi|hey|good morning|good afternoon|good evening|how are you|thanks|thank you|thx|cheers|ok|okay|great|cool|got it|bye|goodbye|can you help me|can you help)';

/** Whole-turn conversation: nothing factual is claimed, so nothing needs grounding. */
const CONVERSATION_ONLY = new RegExp(
  `^(?:\\s*(?:${CONVERSATION_FILLER}|${CONVERSATION_GREETING})[\\s!.,?…]*)+$`,
  'iu',
);

/**
 * Whole-turn shapes for each authoritative configuration field, and the field each one needs.
 *
 * Anchored end to end on purpose. "Adresiniz neresi?" is a question configuration answers;
 * "Adresinizde otopark bulunuyor mu?" only begins like one, and the difference has to be structural
 * rather than a race between keyword lists.
 */
const END = '\\s*[?!.…]*$';

export const CONFIGURATION_QUESTIONS: readonly {
  readonly field: keyof AgentBusinessContext;
  readonly pattern: RegExp;
}[] = [
  // Address
  { field: 'address', pattern: new RegExp(`^adres(iniz|in)?\\s*(ne|nedir|neresi|neresidir|nerede|nerededir)?${END}`, 'u') },
  { field: 'address', pattern: new RegExp(`^neredesiniz${END}`, 'u') },
  { field: 'address', pattern: new RegExp(`^konumunuz\\s*(ne|nedir|nerede)?${END}`, 'u') },
  { field: 'address', pattern: new RegExp(`^(what\\s+is|what's|whats)\\s+your\\s+address${END}`, 'u') },
  { field: 'address', pattern: new RegExp(`^where\\s+are\\s+you\\s+located${END}`, 'u') },
  { field: 'address', pattern: new RegExp(`^(your\\s+)?address${END}`, 'u') },
  // Business hours
  { field: 'businessHours', pattern: new RegExp(`^(çalışma|calisma)?\\s*saatleriniz\\s*(ne|nedir|nelerdir)?${END}`, 'u') },
  { field: 'businessHours', pattern: new RegExp(`^(saat\\s+)?kaçta\\s+(açılıyorsunuz|aciliyorsunuz|açıyorsunuz|aciyorsunuz|kapanıyorsunuz|kapaniyorsunuz|kapatıyorsunuz|kapatiyorsunuz)${END}`, 'u') },
  { field: 'businessHours', pattern: new RegExp(`^(?:bugün|bugun|yarın|yarin|şu an|su an)?\\s*(?:açık|acik)\\s*(?:mısınız|misiniz|mısın|misin)${END}`, 'u') },
  { field: 'businessHours', pattern: new RegExp(`^(what\\s+are\\s+)?your\\s+(business|opening|working)\\s+hours${END}`, 'u') },
  { field: 'businessHours', pattern: new RegExp(`^what\\s+time\\s+do\\s+you\\s+(open|close)${END}`, 'u') },
  { field: 'businessHours', pattern: new RegExp(`^are\\s+you\\s+open(\\s+(today|tomorrow|now))?${END}`, 'u') },
  // Phone
  { field: 'phone', pattern: new RegExp(`^telefon\\s*(numaranız|numaraniz|numarası|numarasi)?\\s*(ne|nedir|kaç|kac)?${END}`, 'u') },
  { field: 'phone', pattern: new RegExp(`^(numaranız|numaraniz)\\s*(ne|nedir)?${END}`, 'u') },
  { field: 'phone', pattern: new RegExp(`^(what\\s+is|what's|whats)\\s+your\\s+(phone|contact)\\s+number${END}`, 'u') },
  { field: 'phone', pattern: new RegExp(`^(your\\s+)?(phone|contact)\\s+number${END}`, 'u') },
  // Website
  { field: 'website', pattern: new RegExp(`^(web\\s*|internet\\s+)?(siteniz|sitenizin\\s+adresi|site\\s+adresiniz|web\\s+adresiniz)\\s*(ne|nedir)?${END}`, 'u') },
  { field: 'website', pattern: new RegExp(`^(what\\s+is|what's|whats)\\s+your\\s+(web\\s*)?site${END}`, 'u') },
  { field: 'website', pattern: new RegExp(`^(your\\s+)?website${END}`, 'u') },
  // Business name
  { field: 'name', pattern: new RegExp(`^(isminiz|adınız|adiniz)\\s*(ne|nedir)?${END}`, 'u') },
  { field: 'name', pattern: new RegExp(`^(what\\s+is|what's|whats)\\s+your\\s+name${END}`, 'u') },
];

/** An appointment, as the object of an action rather than the subject of a question. */
const APPOINTMENT_NOUNS: readonly string[] = [
  'randevu',
  'rezervasyon',
  'appointment',
  'booking',
  'reservation',
];

/**
 * Verbs that act on the appointment itself.
 *
 * The discriminator the earlier version lacked. It exempted any appointment noun beside any action
 * phrase, so "Randevuda botoks yapabilir miyim?" -- "can I have Botox at the appointment" -- was
 * treated as a scheduling mutation because "randevu" and "yapabilir miyim" both appeared. The
 * appointment there is where something happens, not the thing being changed.
 *
 * Booking, cancelling and rescheduling are a small closed set; "do", "bring" and "pay" are not on
 * it, and no blacklist of the things a customer might ask about is required to keep them off.
 */
const SCHEDULING_VERBS: readonly string[] = [
  'almak',
  'alabilir',
  'alayım',
  'alayim',
  'alalım',
  'alalim',
  'alıyorum',
  'aliyorum',
  'alırım',
  'alirim',
  'iptal',
  'ertele',
  'erteleyin',
  'değiştir',
  'degistir',
  'başka gün',
  'baska gun',
  'başka güne',
  'baska gune',
  'oluşturmak',
  'olusturmak',
  'ayarlamak',
  'ayarlayabilir',
  'book',
  'cancel',
  'reschedul',
  'rebook',
  'move my',
];

/**
 * Explicit intent to perform the action, in the first person or as an imperative.
 *
 * Co-occurrence is not intent. "Randevu almak için hangi belgeler gerekiyor?" contains an
 * appointment and a booking verb and is still a question about the business; only a stated wish or
 * a command is an action.
 */
const ACTION_INTENT: readonly string[] = [
  'istiyorum',
  'istiyoruz',
  'isterim',
  'istedim',
  'edebilir miyim',
  'alabilir miyim',
  'iptal et',
  'iptal edin',
  'ertele',
  'erteleyin',
  'i want to',
  'i would like to',
  "i'd like to",
  'i need to',
  'please cancel',
  'please book',
  'please reschedule',
  'please move',
  'can you cancel',
  'can you book',
  'can you reschedule',
  'cancel my',
  'book me',
  'reschedule my',
  'move my',
];

/**
 * Markers that turn an appointment sentence back into a question about the business.
 *
 * Requirements, process and price are all things published knowledge may answer, and none of them
 * are performed by the scheduling tools.
 */
const ENQUIRY_MARKERS: readonly string[] = [
  'gerek',
  'belge',
  'evrak',
  'ne yapmam',
  'ne yapmalı',
  'ne yapmali',
  'nasıl',
  'nasil',
  'how do i',
  'how can i',
  'how does',
  'süreç',
  'surec',
  'prosedür',
  'prosedur',
  'şart',
  'sart',
  'ücret',
  'ucret',
  'fiyat',
  'politika',
  'kural',
  'ceza',
  'requirement',
  'required',
  'document',
  'what do i need',
  'what should i',
  'how does',
  'process',
  'policy',
  'fee',
  'cost',
  'price',
  'charge',
  'penalty',
  'rule',
];

/** Shorter than this is an acknowledgement, not an enquiry about the business. */
const MIN_ENQUIRY_CHARACTERS = 4;

/**
 * True when the runtime must have published knowledge before this turn can be answered.
 *
 * Pure and synchronous: no provider, no network, no model. `business` is the trusted configuration
 * the runtime was given, and it is consulted rather than assumed -- an exemption that cannot check
 * whether the answer exists is not an exemption.
 */
export function requiresBusinessKnowledge(
  message: string,
  business?: AgentBusinessContext,
): boolean {
  const normalized = normalize(message);
  if (normalized.length < MIN_ENQUIRY_CHARACTERS) return false;
  if (CONVERSATION_ONLY.test(normalized)) return false;

  // Configuration answers it, the whole turn asks only that, and the value is actually configured.
  // All three, or the turn is grounded like any other.
  for (const { field, pattern } of CONFIGURATION_QUESTIONS) {
    if (!pattern.test(normalized)) continue;
    const configured = business ? business[field] : null;
    if (isPresent(typeof configured === 'string' ? configured : null)) return false;
    // The shape matched but nothing is configured, so there is no authoritative answer to give.
    // Falling through is the whole point: this is where the model used to be handed a blank page.
    break;
  }

  // A scheduling action: the appointment is the thing being acted on, a scheduling verb acts on
  // it, the customer states intent, and the turn is not asking what the action requires, costs, or
  // involves. All four, because any three of them also describe a question about the business.
  if (
    mentionsAny(normalized, APPOINTMENT_NOUNS) &&
    mentionsAny(normalized, SCHEDULING_VERBS) &&
    mentionsAny(normalized, ACTION_INTENT) &&
    !mentionsAny(normalized, ENQUIRY_MARKERS)
  ) {
    return false;
  }

  return true;
}
