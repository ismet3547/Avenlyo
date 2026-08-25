/**
 * Whether a customer turn is asking for a fact only the business's own published knowledge can
 * answer.
 *
 * This exists because staging caught the model skipping the knowledge tool entirely and then
 * asserting a business-specific fact anyway -- "there is no registration link" -- about a site
 * whose registration page had been published minutes earlier. The prompt already told it to
 * search. An instruction the model can decline is not a control, and the runtime's no-knowledge
 * guard only fires once a search has been attempted, so declining to search bypassed the guard
 * completely.
 *
 * Deliberately not a model call. A classifier that can be wrong in novel ways, on the path whose
 * entire job is to stop the model from being wrong in novel ways, is not a safety mechanism. This
 * is deterministic, auditable, and identical on every run.
 *
 * ## Fail closed, because an allow-list of services cannot be finished
 *
 * The first version asked "does this mention a business topic?" against a keyword list, and the
 * list could never be complete. "Kısırlaştırma yapıyor musunuz?", "Botoks yapıyor musunuz?",
 * "Motor yağı değiştiriyor musunuz?" are all plainly questions about what a business does, and
 * none of them contain the word "service" in any language. Every industry would need its own
 * catalogue, every catalogue would have gaps, and each gap was the original bypass again: model
 * skips search, unsupported service claim goes out.
 *
 * So the question is inverted. The default is that a turn *does* require grounding, and three
 * narrow, well-understood categories are excused. That is affordable precisely because this
 * predicate only ever runs when the model tried to end a turn with no tool call at all: a broader
 * guard costs at most one extra search on that path, while a narrower one costs an ungrounded
 * claim about someone's business.
 *
 * The three exemptions:
 *
 * 1. **Conversation.** Greetings, thanks, acknowledgements, generic openers. Nothing factual is
 *    being asserted, so there is nothing to ground.
 * 2. **Authoritative configuration.** Hours, address, phone, business name, website URL. The
 *    prompt already carries these from configuration, which is a *better* source than a crawled
 *    page. Note the boundary: a configured website URL authorises stating the URL, never claims
 *    about how registering on that site works.
 * 3. **Scheduling and lifecycle actions.** Booking, cancelling, or moving an appointment. Their
 *    authority belongs to the scheduling and lifecycle tools, and website marketing copy is not
 *    the place to answer them from.
 *
 * ## Asking about a policy is not performing an action
 *
 * The distinction the first version got wrong, by listing "iptal"/"cancellation" as knowledge
 * topics while its own comment claimed cancellation was excluded. Both readings are right for
 * different sentences:
 *
 *   "Randevumu iptal etmek istiyorum."   -> lifecycle action, the tools own it
 *   "Randevu iptal ücreti var mı?"       -> policy question, published knowledge may answer it
 *
 * A price or policy marker anywhere in the turn therefore cancels the lifecycle exemption. Asking
 * what cancelling costs is a question about the business; cancelling is a thing you do.
 *
 * ## Mixed turns fail closed
 *
 * Every exemption is judged on the whole turn. "Adresiniz nerede ve kısırlaştırma yapıyor
 * musunuz?" is not exempted as a configuration question, because it is not only a configuration
 * question. Falling through to a forced search is the safe direction.
 */

function normalize(message: string): string {
  return message.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Matches a term at the start of a word.
 *
 * Word-initial rather than anywhere, so a short term cannot fire from inside an unrelated word,
 * and rather than whole-word, so Turkish suffixes still match: "randevumu" starts a word with
 * "randevu", "saatleriniz" with "saatleri".
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

/**
 * Words that carry no enquiry of their own.
 *
 * Listed so "çok teşekkürler" is still just thanks. `\w` is deliberately not used anywhere in this
 * file: it is ASCII-only even under the `u` flag, so it silently fails on exactly the Turkish
 * characters this predicate exists to read -- "nasılsınız" does not match `nasılsın\w*`.
 */
const CONVERSATION_FILLER = '(?:çok|cok|very|so|really|much|ve|and|bir|de|da|lütfen|lutfen|please)';

const CONVERSATION_GREETING =
  '(?:merhaba|selam\\p{L}*|günaydın|gunaydin|iyi günler|iyi gunler|iyi akşamlar|iyi aksamlar|nasıls\\p{L}*|nasils\\p{L}*|teşekkür\\p{L}*|tesekkur\\p{L}*|sağ ol\\p{L}*|sag ol\\p{L}*|eyvallah|rica ederim|tamam\\p{L}*|peki|olur|anladım|anladim|görüşürüz|gorusuruz|hoşça kal\\p{L}*|hosca kal\\p{L}*|yardımcı olabilir misin\\p{L}*|yardimci olabilir misin\\p{L}*|hello|hi|hey|good morning|good afternoon|good evening|how are you|thanks|thank you|thx|cheers|ok|okay|great|cool|got it|bye|goodbye|can you help me|can you help)';

/** Whole-turn conversation: nothing factual is claimed, so nothing needs grounding. */
const CONVERSATION_ONLY = new RegExp(
  `^(?:\\s*(?:${CONVERSATION_FILLER}|${CONVERSATION_GREETING})[\\s!.,?…]*)+$`,
  'iu',
);

/**
 * Facts the prompt already carries from authoritative business configuration.
 *
 * Kept tight on purpose. A term missing from here costs one unnecessary forced search; a term too
 * loose here excuses a turn that should have been grounded, which is the failure this guard exists
 * to prevent.
 */
const CONFIGURATION_TERMS: readonly string[] = [
  'çalışma saat',
  'calisma saat',
  'saatleri',
  'kaçta',
  'kacta',
  'açık mısınız',
  'acik misiniz',
  'adresiniz',
  'adresini',
  'konumunuz',
  'neredesiniz',
  'telefon',
  'numaranız',
  'numaraniz',
  'web siteniz',
  'siteniz',
  'web adresiniz',
  'isminiz',
  'adınız',
  'business hours',
  'opening hours',
  'your address',
  'where are you located',
  'phone number',
  'contact number',
  'your website',
  'your name',
];

/** Signals that a turn asks for something configuration cannot answer, even if it also asks hours. */
const BEYOND_CONFIGURATION_TERMS: readonly string[] = [
  'fiyat',
  'ücret',
  'ucret',
  'politika',
  'kural',
  'şart',
  'sart',
  'gerek',
  'kayıt',
  'kayit',
  'kayd',
  'üye',
  'uye',
  'hesap',
  'hizmet',
  'yapıyor mu',
  'yapiyor mu',
  'sunuyor mu',
  'var mı',
  'var mi',
  'price',
  'pricing',
  'cost',
  'fee',
  'policy',
  'require',
  'register',
  'account',
  'service',
  'do you do',
  'do you offer',
  'do you perform',
  'do you provide',
];

/** An appointment being acted on, rather than asked about. */
const APPOINTMENT_NOUNS: readonly string[] = [
  'randevu',
  'rezervasyon',
  'appointment',
  'booking',
  'reservation',
];

const APPOINTMENT_ACTIONS: readonly string[] = [
  'iptal',
  'ertele',
  'değiştir',
  'degistir',
  'başka gün',
  'baska gun',
  'başka güne',
  'baska gune',
  'almak',
  'alabilir',
  'alayım',
  'alayim',
  'oluştur',
  'olustur',
  'ayarla',
  'book',
  'schedule',
  'reschedul',
  'rebook',
  'cancel',
  'move',
  'change',
];

/** Price and policy markers, which turn an appointment mention into a question about the business. */
const POLICY_MARKERS: readonly string[] = [
  'ücret',
  'ucret',
  'fiyat',
  'politika',
  'kural',
  'şart',
  'sart',
  'ceza',
  'fee',
  'cost',
  'price',
  'policy',
  'charge',
  'penalty',
  'rule',
];

/** Shorter than this is an acknowledgement, not an enquiry about the business. */
const MIN_ENQUIRY_CHARACTERS = 4;

/**
 * True when the runtime must have published knowledge before this turn can be answered.
 *
 * Pure and synchronous: no provider, no network, no model. The same input always produces the same
 * answer, which is what makes it something a reviewer can hold the runtime to.
 */
export function requiresBusinessKnowledge(message: string): boolean {
  const normalized = normalize(message);
  if (normalized.length < MIN_ENQUIRY_CHARACTERS) return false;
  if (CONVERSATION_ONLY.test(normalized)) return false;

  // Configuration answers it, and only configuration is being asked about.
  if (
    mentionsAny(normalized, CONFIGURATION_TERMS) &&
    !mentionsAny(normalized, BEYOND_CONFIGURATION_TERMS)
  ) {
    return false;
  }

  // An appointment is being acted on. Asking what an action *costs* or what the policy *is* is not
  // acting on it, so a price or policy marker keeps the turn in knowledge territory.
  if (
    mentionsAny(normalized, APPOINTMENT_NOUNS) &&
    mentionsAny(normalized, APPOINTMENT_ACTIONS) &&
    !mentionsAny(normalized, POLICY_MARKERS)
  ) {
    return false;
  }

  return true;
}
