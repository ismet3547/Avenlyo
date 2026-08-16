const knownAuthErrors: Record<string, string> = {
  email_not_confirmed: 'Confirm your email address before signing in.',
  invalid_credentials: 'The email or password is incorrect.',
  user_already_exists: 'An account already exists for this email address.',
  weak_password: 'Choose a stronger password with at least eight characters.',
};

export function getSafeAuthError(code: string | undefined): string {
  return (code && knownAuthErrors[code]) ?? 'Authentication could not be completed. Try again.';
}
