import type { CapabilityReport } from './capabilities.js';
import type { RuntimeComponent } from './runtime-state.js';

/**
 * Readiness answers one question: can this replica safely receive normal production traffic?
 *
 * It validates local facts only — configuration, database reachability, schema compatibility, and
 * this process's own scheduler state. It deliberately never probes OpenAI, Twilio, Google, ezyVet,
 * or Stripe: a provider outage must not turn every replica into a client that hammers that provider
 * on every load-balancer check, and provider execution truth already lives in the durable queues.
 *
 * A single failed job is degradation, not unreadiness. Readiness fails only when the process cannot
 * do its work at all.
 */

/** Raised when this application build needs migrations the deployed database does not have yet. */
export const REQUIRED_SCHEMA_VERSION = 16;

export type ReadinessReason =
  | 'shutting_down'
  | 'starting_up'
  | 'configuration_partial'
  | 'database_not_configured'
  | 'database_unavailable'
  | 'schema_incompatible'
  | 'worker_scheduler_failed';

export interface ReadinessInput {
  readonly capabilities: CapabilityReport;
  readonly draining: boolean;
  /**
   * Whether this process finished its own local startup. Defaults to true so existing callers
   * and tests that do not model startup are unaffected.
   */
  readonly localStartupComplete?: boolean;
  readonly probe: DatabaseProbeResult | null;
  readonly requiredSchemaVersion?: number;
  readonly schedulerFailures: readonly RuntimeComponent[];
}

export type DatabaseProbeResult =
  { readonly ok: true; readonly schemaVersion: number } | { readonly ok: false };

export interface ReadinessResult {
  readonly ready: boolean;
  /** Bounded reason codes for sanitized server logs and the trusted CLI, never for the public body. */
  readonly reasons: readonly ReadinessReason[];
  readonly schemaVersion: number | null;
}

export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
  const required = input.requiredSchemaVersion ?? REQUIRED_SCHEMA_VERSION;
  const reasons: ReadinessReason[] = [];

  if (input.draining) reasons.push('shutting_down');
  // The HTTP listener comes up before startup finishes so liveness never depends on a database.
  // Readiness has to close that window explicitly, or a replica would advertise itself as able
  // to serve while its worker schedulers were still being started.
  if (input.localStartupComplete === false) reasons.push('starting_up');
  // Half a provider configuration is not a disabled provider. Fail loudly instead of quietly
  // running a deployment whose Twilio, Stripe, or Google boundary is only partly present.
  if (input.capabilities.partial.length > 0) reasons.push('configuration_partial');
  if (input.capabilities.capabilities.supabase_core !== 'configured') {
    reasons.push('database_not_configured');
  }
  if (input.schedulerFailures.length > 0) reasons.push('worker_scheduler_failed');

  let schemaVersion: number | null = null;
  if (input.probe === null || !input.probe.ok) {
    // A missing probe is only a database problem when the database was supposed to be configured.
    if (!reasons.includes('database_not_configured')) reasons.push('database_unavailable');
  } else {
    schemaVersion = input.probe.schemaVersion;
    // Greater-than is intentional: a newer additive schema must keep an older build serving so a
    // rollback is possible without a destructive down migration.
    if (input.probe.schemaVersion < required) reasons.push('schema_incompatible');
  }

  return { ready: reasons.length === 0, reasons, schemaVersion };
}
