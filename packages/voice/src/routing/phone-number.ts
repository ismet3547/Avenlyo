export const e164Pattern = /^\+[1-9][0-9]{7,14}$/;

/** Accept only already-canonical public telephone numbers; no guessed normalization is allowed. */
export function normalizeE164(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return e164Pattern.test(normalized) ? normalized : null;
}

export function isE164(value: string): boolean {
  return normalizeE164(value) !== null;
}
