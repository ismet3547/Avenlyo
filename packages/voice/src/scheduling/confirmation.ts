/**
 * A deliberately conservative detector for the final caller utterance. The runtime still checks
 * that the intent belongs to the active conversation; this merely prevents model text from being
 * treated as consent.
 */
export function hasExplicitBookingConfirmation(transcript: string | null | undefined): boolean {
  if (!transcript) return false;
  const normalized = transcript.trim().toLocaleLowerCase('en-US');
  if (normalized.length === 0 || normalized.length > 1_000) return false;
  return /\b(yes|yeah|yep|please book|go ahead|confirm|that works|sounds good)\b/.test(normalized);
}
