export interface HumanRequestInterrupt {
  readonly reason: string;
  readonly reply: string;
  readonly urgency: 'normal';
}

function normalized(message: string): string {
  return message
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const englishPatterns = [
  /\b(?:speak|talk|chat) (?:to|with) (?:a )?(?:human|person|representative|agent|receptionist|staff member)\b/,
  /\b(?:connect|transfer|put) me (?:through )?(?:to|with) (?:a )?(?:human|person|representative|agent|receptionist|staff member)\b/,
  /\b(?:i )?(?:want|need) (?:to )?(?:speak|talk|chat) (?:to|with) (?:a )?(?:human|person|representative|agent|receptionist|staff member)\b/,
  /\bcan i (?:speak|talk|chat) (?:to|with) (?:a )?(?:human|person|representative|agent|receptionist|staff member)\b/,
] as const;

const turkishPhrases = [
  'bir insanla konusmak istiyorum',
  'insanla konusmak istiyorum',
  'bir temsilciyle konusmak istiyorum',
  'temsilciyle konusmak istiyorum',
  'yetkiliyle konusmak istiyorum',
  'personelle konusmak istiyorum',
  'calisanla konusmak istiyorum',
  'bir insana bagla',
  'insana bagla',
  'birine bagla',
  'temsilciye bagla',
  'yetkiliye bagla',
  'canli destege bagla',
  'bir insanla gorusmek istiyorum',
  'temsilciyle gorusmek istiyorum',
  'yetkiliyle gorusmek istiyorum',
] as const;

/**
 * Conservative deterministic interrupt for clear requests to leave AI handling.
 *
 * This intentionally does not match mere mentions such as "are you human?", "what does your
 * receptionist do?", or "do you have live support?". Ambiguous phrasing remains ordinary model
 * understanding; only unmistakable customer requests bypass the model and enter human control.
 */
export function detectExplicitHumanRequest(userMessage: string): HumanRequestInterrupt | null {
  const message = normalized(userMessage);
  const requested =
    englishPatterns.some((pattern) => pattern.test(message)) ||
    turkishPhrases.some((phrase) => message.includes(phrase));
  if (!requested) return null;
  return {
    reason: 'Customer explicitly requested human assistance.',
    reply: 'Of course. I’m asking the team to help you now.',
    urgency: 'normal',
  };
}
