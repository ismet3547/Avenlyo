/**
 * One source-controlled description of which runtime capabilities this process is configured for.
 *
 * A capability is `configured` when every setting it needs is present, `disabled` when the operator
 * clearly never intended to enable it, and `partial` when some but not all of its settings exist.
 * Partial is the important state: half a provider configuration is not a disabled provider, it is a
 * deployment that will fail somewhere later, so readiness treats it as unsafe rather than silently
 * turning the capability off.
 *
 * This module is pure and never reads process.env itself, so `env.ts` can derive its existing
 * runtime flags from it without a circular import and without a second copy of the rules.
 */

export type CapabilityStatus = 'configured' | 'disabled' | 'partial';

export type CapabilityName =
  | 'supabase_core'
  | 'openai_text'
  | 'openai_voice'
  | 'twilio_messaging'
  | 'google_calendar'
  | 'ezyvet'
  | 'stripe_billing';

export interface CapabilityEnvironment {
  readonly EZYVET_PARTNER_ID?: string | undefined;
  readonly GOOGLE_CLIENT_ID?: string | undefined;
  readonly GOOGLE_CLIENT_SECRET?: string | undefined;
  readonly GOOGLE_OAUTH_REDIRECT_URI?: string | undefined;
  readonly OPENAI_API_KEY?: string | undefined;
  readonly OPENAI_WEBHOOK_SECRET?: string | undefined;
  readonly STRIPE_MODE?: string | undefined;
  readonly STRIPE_PRICE_CORE_MONTHLY?: string | undefined;
  readonly STRIPE_PRODUCT_CORE?: string | undefined;
  readonly STRIPE_SECRET_KEY?: string | undefined;
  readonly STRIPE_WEBHOOK_SECRET?: string | undefined;
  readonly SUPABASE_ANON_KEY?: string | undefined;
  readonly SUPABASE_SERVICE_ROLE_KEY?: string | undefined;
  readonly SUPABASE_URL?: string | undefined;
  readonly TWILIO_ACCOUNT_SID?: string | undefined;
  readonly TWILIO_AUTH_TOKEN?: string | undefined;
  readonly TWILIO_MESSAGING_WEBHOOK_BASE_URL?: string | undefined;
}

type CapabilityKey = keyof CapabilityEnvironment;

interface CapabilityDefinition {
  /** Settings that only this capability uses. Any one of them signals operator intent to enable it. */
  readonly primary: readonly CapabilityKey[];
  /** Settings this capability also needs but shares with another capability. */
  readonly shared: readonly CapabilityKey[];
}

const CAPABILITY_DEFINITIONS: Readonly<Record<CapabilityName, CapabilityDefinition>> = {
  ezyvet: { primary: ['EZYVET_PARTNER_ID'], shared: [] },
  google_calendar: {
    primary: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI'],
    shared: [],
  },
  openai_text: { primary: ['OPENAI_API_KEY'], shared: [] },
  // Voice is opted into by its webhook secret. A text-only deployment that sets no webhook secret
  // is disabled voice, not a half-configured one.
  openai_voice: { primary: ['OPENAI_WEBHOOK_SECRET'], shared: ['OPENAI_API_KEY'] },
  stripe_billing: {
    primary: [
      'STRIPE_MODE',
      'STRIPE_PRICE_CORE_MONTHLY',
      'STRIPE_PRODUCT_CORE',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
    ],
    shared: [],
  },
  supabase_core: {
    primary: ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
    shared: [],
  },
  twilio_messaging: {
    primary: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_WEBHOOK_BASE_URL'],
    shared: [],
  },
};

export const CAPABILITY_NAMES = Object.keys(
  CAPABILITY_DEFINITIONS,
).sort() as readonly CapabilityName[];

export interface CapabilityReport {
  readonly capabilities: Readonly<Record<CapabilityName, CapabilityStatus>>;
  /** Capability names only. Setting names and values are never surfaced. */
  readonly partial: readonly CapabilityName[];
}

function isPresent(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function statusFor(
  environment: CapabilityEnvironment,
  definition: CapabilityDefinition,
): CapabilityStatus {
  const primaryPresent = definition.primary.filter((key) => isPresent(environment[key]));
  if (primaryPresent.length === 0) return 'disabled';
  const sharedMissing = definition.shared.some((key) => !isPresent(environment[key]));
  if (primaryPresent.length < definition.primary.length || sharedMissing) return 'partial';
  return 'configured';
}

export function describeRuntimeCapabilities(environment: CapabilityEnvironment): CapabilityReport {
  const capabilities = {} as Record<CapabilityName, CapabilityStatus>;
  for (const name of CAPABILITY_NAMES) {
    capabilities[name] = statusFor(environment, CAPABILITY_DEFINITIONS[name]);
  }
  const partial = CAPABILITY_NAMES.filter((name) => capabilities[name] === 'partial');
  return { capabilities, partial };
}

/** The trusted backend boundary every worker and webhook path needs before it can do anything. */
export function isTrustedBackendConfigured(environment: CapabilityEnvironment): boolean {
  return isPresent(environment.SUPABASE_URL) && isPresent(environment.SUPABASE_SERVICE_ROLE_KEY);
}
