/**
 * Whether a customer turn is asking for a fact only the business's own published knowledge can
 * answer.
 *
 * This exists because staging caught the model skipping the knowledge tool entirely and then
 * asserting a business-specific fact anyway -- "there is no registration link" -- about a site
 * whose registration page had been published minutes earlier. The prompt already told it to
 * search. An instruction the model can decline is not a control, and the runtime's
 * no-knowledge guard only fires once a search has been attempted, so declining to search bypassed
 * the guard completely.
 *
 * So the decision moves into source control. Deliberately a keyword predicate and not a model
 * call: a classifier that can be wrong in novel ways, on the path whose entire job is to stop the
 * model from being wrong in novel ways, is not a safety mechanism. This is auditable, testable,
 * and identical on every run.
 *
 * ## Conservative in one direction on purpose
 *
 * Default is *false*. A turn only requires knowledge if it names a topic that published website
 * content is the authority for. Getting this wrong in the false direction costs one unnecessary
 * refusal path; getting it wrong in the true direction costs a forced search on "thanks". The
 * asymmetry is the design.
 *
 * ## What is deliberately absent
 *
 * Hours, address, phone, business name, and the website URL itself are **not** here. Those come
 * from authoritative business configuration, which the prompt already carries, so forcing a
 * website search for them would be both wasteful and wrong -- the configured value is the better
 * source. Note the boundary though: a configured website URL authorizes stating the URL, never
 * claims about how registering on that site works. "kayıt" is a knowledge topic; "web sitesi" on
 * its own is not.
 *
 * Scheduling, booking, cancellation and rescheduling are absent too. Their authority belongs to
 * the scheduling and lifecycle tools, not to crawled marketing copy.
 */

/**
 * Topics whose answers live in published business knowledge.
 *
 * Turkish and English, because the staging corpus and the customers are Turkish while the codebase
 * and other tenants are English. Turkish is agglutinative -- "kayıt" becomes "kayıtlı",
 * "kayıtsız", "kaydolmak" -- so these are matched as word *prefixes* rather than whole words, which
 * is why the list holds stems like `kayd` alongside `kayıt`.
 */
const BUSINESS_KNOWLEDGE_TERMS: readonly string[] = [
  // Registration and accounts
  'kayıt',
  'kayit',
  'kayd',
  'üye',
  'uye',
  'hesap',
  'abone',
  'register',
  'registration',
  'signup',
  'sign-up',
  'account',
  'enroll',
  // Services offered
  'hizmet',
  'servis',
  'service',
  'services',
  'offer',
  'provide',
  // Pricing
  'fiyat',
  'ücret',
  'ucret',
  'tarife',
  'price',
  'pricing',
  'cost',
  'fee',
  'charge',
  // Policies and terms
  'politika',
  'kural',
  'şart',
  'sart',
  'koşul',
  'kosul',
  'iade',
  'iptal',
  'policy',
  'policies',
  'terms',
  'refund',
  'cancellation',
  'guarantee',
  'garanti',
  'warranty',
  // Process, requirements, eligibility, FAQ
  'süreç',
  'surec',
  'prosedür',
  'prosedur',
  'gerek',
  'şart',
  'belge',
  'evrak',
  'process',
  'procedure',
  'requirement',
  'required',
  'eligib',
  'document',
  'faq',
  // New client / new patient
  'yeni hasta',
  'yeni müşteri',
  'yeni musteri',
  'ilk ziyaret',
  'new patient',
  'new client',
  'first visit',
  // Website content and instructions
  'sayfa',
  'bağlantı',
  'baglanti',
  'link',
  'website page',
  'web page',
];

/**
 * Turns that are conversation rather than enquiry.
 *
 * Checked first and independently of the topic list, so "teşekkürler" cannot be dragged into a
 * forced search by an unrelated word that happens to share a stem.
 */
const PLEASANTRY_ONLY =
  /^(\s*(merhaba|selam|günaydın|gunaydin|iyi günler|iyi gunler|iyi akşamlar|iyi aksamlar|teşekkür\w*|tesekkur\w*|sağ ol\w*|sag ol\w*|eyvallah|tamam|peki|olur|hello|hi|hey|good morning|good afternoon|good evening|thanks|thank you|thx|ok|okay|great|cool|bye|goodbye|görüşürüz|gorusuruz)[\s!.,?…]*)+$/iu;

/** Shorter than this is an acknowledgement, not a question about the business. */
const MIN_ENQUIRY_CHARACTERS = 4;

function normalize(message: string): string {
  return message.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Matches a term at the start of a word.
 *
 * Word-initial rather than anywhere, so `uye` cannot fire inside an unrelated word, and rather
 * than whole-word, so Turkish suffixes still match: "kayıtlıyım" starts a word with "kayıt".
 */
function mentionsTerm(normalized: string, term: string): boolean {
  const index = normalized.indexOf(term);
  if (index === -1) return false;
  if (index === 0) return true;
  return !/\p{L}|\p{N}/u.test(normalized.charAt(index - 1));
}

/**
 * True when the runtime must have published knowledge before this turn can be answered.
 *
 * Pure and synchronous: no provider, no network, no model. The same input always produces the same
 * answer, which is what makes it something a reviewer can hold the runtime to.
 */
export function requiresBusinessKnowledge(message: string): boolean {
  const normalized = normalize(message);
  if (normalized.length < MIN_ENQUIRY_CHARACTERS) return false;
  if (PLEASANTRY_ONLY.test(normalized)) return false;
  return BUSINESS_KNOWLEDGE_TERMS.some((term) => mentionsTerm(normalized, term));
}
