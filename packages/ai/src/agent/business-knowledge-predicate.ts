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
 * - It treated the co-occurrence of an appointment noun, a scheduling verb and an action phrase as
 *   a scheduling action, anywhere across the turn. "Randevu almak istiyorum, botoks yapıyor
 *   musunuz?" satisfies all three, so the whole turn was exempted and the Botox half reached the
 *   customer ungrounded. Co-occurrence is not a whole-turn test at any level of narrowness, and the
 *   answer is not another marker list -- a list of the services a customer might ask about is
 *   exactly the unfinishable thing this predicate exists to avoid. Scheduling actions are now
 *   matched as whole turns against anchored mutation shapes, so any residual clause grounds the
 *   turn.
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

/**
 * Date, time and target qualifiers a scheduling turn is allowed to carry.
 *
 * A closed set, and deliberately a boring one: every member says *when* or *which occurrence*, and
 * none of them says anything about the business. Admitting them around the scheduling clause
 * therefore cannot smuggle a factual question into an exempt turn. Anything outside the set is
 * residual content, and residual content grounds the turn.
 */
const TR_QUALIFIER =
  "(?:bugün|bugun|bugünkü|bugunku|yarın|yarin|yarınki|yarinki|yarına|yarina|öbür gün|obur gun|haftaya|bu hafta|gelecek hafta|pazartesi|salı|sali|çarşamba|carsamba|perşembe|persembe|cuma|cumartesi|pazar|sabah|sabaha|öğleden sonra|ogleden sonra|akşam|aksam|akşama|aksama|başka bir güne|baska bir gune|başka güne|baska gune|başka saate|baska saate|için|icin|günü|gunu|saat|\\d{1,2}(?:[:.]\\d{2})?(?:'\\p{L}{1,3})?)";

/** The appointment itself, with the possessive suffixes that make it the object of an action. */
const TR_APPOINTMENT = "(?:randevu|rezervasyon)(?:m|mu|muzu|nuzu|umu|umuzu|unuzu)?";

/** A stated wish. Co-occurrence is not intent, and neither is a bare infinitive. */
const TR_INTENT = "(?:istiyorum|istiyoruz|isterim|istedim|istiyordum)";

/**
 * The predicate half of a scheduling mutation: booking, cancelling, rescheduling.
 *
 * A small closed set of complete verb phrases rather than verb stems. "iptal ücreti" and "iptal
 * süreciniz" begin with the same word as "iptal etmek istiyorum" and are questions about the
 * business; requiring the whole phrase is what separates them, without knowing anything about fees
 * or processes.
 */
const TR_SCHEDULING_PREDICATE =
  `(?:(?:al|oluştur|olustur|ayarla)(?:mak|ma)\\s+${TR_INTENT}` +
  `|(?:alabilir|oluşturabilir|olusturabilir|ayarlayabilir)\\s+mi(?:yim|yiz)` +
  `|al(?:ayım|ayim|alım|alim)` +
  `|iptal\\s+et(?:mek|me)\\s+${TR_INTENT}` +
  `|iptal\\s+edebilir\\s+mi(?:yim|yiz)` +
  `|iptal\\s+et(?:in|iniz|elim)?` +
  `|(?:ertele|değiştir|degistir|taşı|tasi)(?:mek|mak|me|ma)\\s+${TR_INTENT}` +
  `|(?:erteleyebilir|değiştirebilir|degistirebilir|taşıyabilir|tasiyabilir)\\s+mi(?:yim|yiz)` +
  `|(?:erteleyin|ertele|değiştirin|degistirin|değiştir|degistir|taşıyın|tasiyin)` +
  `)`;

const EN_QUALIFIER =
  "(?:for|on|at|in|to|this|next|the|today|tomorrow|tonight|morning|afternoon|evening|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|o'clock|asap|please|\\d{1,2}(?::\\d{2})?(?:am|pm)?)";

const EN_APPOINTMENT = "(?:appointment|booking|reservation)s?";

const EN_INTENT =
  "(?:i want to|i wanna|i would like to|i'd like to|i need to|i'm looking to|im looking to|can you please|could you please|would you please|can you|could you|would you|can i|could i|may i|please)";

const EN_SCHEDULING_VERB =
  "(?:book|schedule|make|set up|arrange|cancel|reschedule|rebook|move|change|postpone)";

/**
 * Whole-turn shapes for a scheduling mutation.
 *
 * Anchored end to end, exactly like the configuration questions above and for exactly the same
 * reason. The turn has to *be* the scheduling action: an optional qualifier, the appointment, the
 * mutation phrase, an optional qualifier, end of turn. A second clause -- "..., botoks yapıyor
 * musunuz?", "... and do you offer oil changes?" -- leaves nothing to match, and no match means the
 * turn is grounded like any other.
 *
 * The cost of that strictness is a search on a phrasing nobody enumerated here. The cost of the
 * co-occurrence test it replaces was a business claim nobody checked.
 */
export const SCHEDULING_ACTIONS: readonly RegExp[] = [
  new RegExp(
    `^(?:${TR_QUALIFIER}\\s+){0,5}${TR_APPOINTMENT}\\s+(?:${TR_QUALIFIER}\\s+){0,5}${TR_SCHEDULING_PREDICATE}(?:\\s+${TR_QUALIFIER}){0,5}${END}`,
    'u',
  ),
  new RegExp(
    `^(?:${EN_INTENT}\\s+){0,2}${EN_SCHEDULING_VERB}\\s+(?:a|an|my|our|the)\\s+(?:${EN_QUALIFIER}\\s+){0,3}${EN_APPOINTMENT}(?:\\s+${EN_QUALIFIER}){0,6}${END}`,
    'u',
  ),
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

  // A scheduling mutation, tested against the whole turn rather than counted across it.
  if (SCHEDULING_ACTIONS.some((pattern) => pattern.test(normalized))) return false;

  return true;
}
