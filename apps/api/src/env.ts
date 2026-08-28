import 'dotenv/config';

import {
  parseEnvironment,
  resolveDeploymentEnvironment,
  type DeploymentEnvironment,
} from '@avenlyo/shared';
import { WORKSPACE_PROOF_MIN_SECRET_LENGTH } from '@avenlyo/shared/workspace-proof';
import { z } from 'zod';

import {
  describeRuntimeCapabilities,
  isTrustedBackendConfigured,
} from './observability/capabilities.js';

export const env = parseEnvironment(
  z.object({
    API_CORS_ORIGIN: z.string().url().default('http://localhost:3000'),
    /**
     * Which deployment this process belongs to. Deliberately separate from NODE_ENV, because
     * staging and production both run NODE_ENV=production and are otherwise indistinguishable.
     * Validated below rather than here so a missing value can be judged against NODE_ENV.
     */
    AVENLYO_DEPLOYMENT_ENV: z.string().trim().min(1).max(20).optional(),
    /** Optional, non-secret. Declaring it lets preflight prove the intended Supabase project. */
    AVENLYO_EXPECTED_SUPABASE_PROJECT_REF: z.string().trim().min(1).max(60).optional(),
    AVENLYO_RELEASE: z.string().trim().min(1).max(120).optional(),
    // Server-only, and shared with the Next.js server alone. It authenticates the selected
    // workspace a billing mutation is acting on; it is never an authorization by itself, never
    // reaches a browser, and is deliberately not prefixed NEXT_PUBLIC_.
    AVENLYO_INTERNAL_BILLING_SECRET: z.string().min(WORKSPACE_PROOF_MIN_SECRET_LENGTH).optional(),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    EZYVET_PARTNER_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
    // Where this host keeps its Chromium binary, when it has one. Optional on purpose: an
    // unconfigured host still serves every static website import and answers the rest with a
    // bounded "rendering is not available" message rather than failing to start.
    KNOWLEDGE_RENDERER_EXECUTABLE_PATH: z.string().min(1).optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_AGENT_MODEL: z.string().min(1).default('gpt-5.6'),
    OPENAI_PROJECT_ID: z.string().min(1).optional(),
    OPENAI_REALTIME_MODEL: z.literal('gpt-realtime-2.1').default('gpt-realtime-2.1'),
    OPENAI_WEBHOOK_SECRET: z.string().min(1).optional(),
    SUPABASE_ANON_KEY: z.string().min(1).optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
    SUPABASE_URL: z.string().url().optional(),
    STRIPE_MODE: z.enum(['test', 'live']).optional(),
    STRIPE_PRICE_CORE_MONTHLY: z.string().min(1).optional(),
    STRIPE_PRODUCT_CORE: z.string().min(1).optional(),
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    TWILIO_ACCOUNT_SID: z
      .string()
      .regex(/^AC[a-zA-Z0-9]{32}$/)
      .optional(),
    TWILIO_AUTH_TOKEN: z.string().min(16).optional(),
    TWILIO_MESSAGING_WEBHOOK_BASE_URL: z.string().url().optional(),
    WEB_CHAT_IFRAME_ORIGIN: z.string().url().default('http://localhost:3000'),
  }),
);

if (
  env.NODE_ENV === 'production' &&
  env.TWILIO_MESSAGING_WEBHOOK_BASE_URL &&
  !env.TWILIO_MESSAGING_WEBHOOK_BASE_URL.startsWith('https://')
) {
  throw new Error('TWILIO_MESSAGING_WEBHOOK_BASE_URL must use HTTPS in production.');
}

if (env.NODE_ENV === 'production' && !env.WEB_CHAT_IFRAME_ORIGIN.startsWith('https://')) {
  throw new Error('WEB_CHAT_IFRAME_ORIGIN must use HTTPS in production.');
}

if (
  env.STRIPE_MODE &&
  env.STRIPE_SECRET_KEY &&
  !env.STRIPE_SECRET_KEY.startsWith(env.STRIPE_MODE === 'live' ? 'sk_live_' : 'sk_test_')
) {
  throw new Error('STRIPE_SECRET_KEY must match the configured STRIPE_MODE.');
}

if (env.NODE_ENV === 'production' && env.STRIPE_MODE === 'test') {
  throw new Error('STRIPE_MODE must be live in production.');
}

/**
 * Capability status is derived once from the validated environment so provider configuration has a
 * single definition. The runtime flags below stay exactly as narrow as they were: each one still
 * requires its own provider settings plus the trusted backend boundary.
 */
export const runtimeCapabilities = describeRuntimeCapabilities(env);

const trustedBackendConfigured = isTrustedBackendConfigured(env);

export const isSupabaseConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);

export const isVoiceRuntimeConfigured =
  runtimeCapabilities.capabilities.openai_voice === 'configured' && trustedBackendConfigured;

export const isEzyVetRuntimeConfigured =
  runtimeCapabilities.capabilities.ezyvet === 'configured' && trustedBackendConfigured;

export const isGoogleCalendarRuntimeConfigured =
  runtimeCapabilities.capabilities.google_calendar === 'configured' && trustedBackendConfigured;

export const isTwilioMessagingConfigured =
  runtimeCapabilities.capabilities.twilio_messaging === 'configured' && trustedBackendConfigured;

/** Billing stays fail-closed when any server-only Stripe boundary is unconfigured. */
export const isStripeBillingConfigured =
  runtimeCapabilities.capabilities.stripe_billing === 'configured' && trustedBackendConfigured;

export const expectedStripeLivemode = env.STRIPE_MODE === 'live';

/** A deployment identifier the operator supplies. Never generated per request, never a secret. */
export const release = env.AVENLYO_RELEASE ?? 'unknown';

/**
 * Which deployment this is, resolved once at the boundary and fail-closed.
 *
 * A container running NODE_ENV=production without declaring this raises here, at startup, rather
 * than letting every downstream environment check silently assume the friendlier answer.
 */
export const deploymentEnvironment: DeploymentEnvironment = resolveDeploymentEnvironment({
  deploymentEnv: env.AVENLYO_DEPLOYMENT_ENV,
  nodeEnv: env.NODE_ENV,
});

/** True only for a real deployment, where release identity and public URL policy are enforced. */
export const isDeployedEnvironment = deploymentEnvironment !== 'development';
