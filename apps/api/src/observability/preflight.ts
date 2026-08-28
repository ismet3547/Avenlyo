import {
  evaluateDeploymentConfig,
  isExactReleaseSha,
  supabaseIdentityAssurance,
  type DeploymentConfigInput,
  type DeploymentEnvironment,
} from '@avenlyo/shared';

import type { CapabilityName, CapabilityReport } from './capabilities.js';

/**
 * The pre-deployment safety gate, as a pure function.
 *
 * Three commands, three jobs, and keeping them distinct is the point:
 *
 *   ops:preflight    before/around a deploy -- is this configuration safe to run here at all
 *   smoke:production after a deploy -- is the public service up and serving the release we meant
 *   ops:status       any time -- what is the platform actually doing right now
 *
 * Preflight is read-only by construction. It takes a snapshot of already-validated configuration and
 * an optional schema probe result; it has no database handle of its own, no provider client, and no
 * way to write anything. That is enforced by the type, not by discipline.
 *
 * Every finding carries a check name, an outcome and source-controlled text. No value from the
 * environment is ever placed in a result, so the whole report is safe to print in a terminal that an
 * operator holding the service-role key is looking at.
 */

export type PreflightOutcome = 'pass' | 'fail' | 'skip';

export interface PreflightCheck {
  readonly detail: string;
  readonly name: string;
  readonly outcome: PreflightOutcome;
}

export interface PreflightReport {
  readonly checks: readonly PreflightCheck[];
  readonly deployment_environment: DeploymentEnvironment;
  readonly failed: readonly string[];
  readonly ok: boolean;
  /** Present only when a schema probe was supplied; preflight never opens its own connection. */
  readonly required_schema_version: number;
  readonly schema_version: number | null;
}

export interface PreflightInput {
  readonly capabilities: CapabilityReport;
  readonly config: DeploymentConfigInput;
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly expectedSupabaseProjectRef?: string | undefined;
  readonly release: string;
  readonly requiredSchemaVersion: number;
  /** null when the caller could not probe; the check reports `skip` rather than inventing a pass. */
  readonly schemaVersion: number | null;
  readonly supabaseUrl?: string | undefined;
}

/**
 * Capabilities that must actually be configured before a production deployment.
 *
 * Kept deliberately short, and justified from the product rather than from "the variable exists":
 *
 *  - `supabase_core` is the trusted backend. Without it there is no database, no RLS boundary and no
 *    worker; nothing in Avenlyo functions.
 *  - `openai_text` is the AI front office. It is the product. A deployment without it serves a
 *    dashboard whose central feature answers nothing.
 *
 * Everything else -- voice, Twilio messaging, Google Calendar, ezyVet, Stripe billing -- is a real
 * integration a launch may legitimately not have yet. Reporting those as broken would make preflight
 * cry wolf, so a cleanly disabled optional integration passes and is listed as disabled.
 *
 * A *partial* capability always fails, for any capability including the optional ones: half a
 * provider configuration is not a disabled provider, it is a deployment that fails later, somewhere
 * less convenient.
 */
export const PRODUCTION_REQUIRED_CAPABILITIES: readonly CapabilityName[] = [
  'supabase_core',
  'openai_text',
];

function check(name: string, outcome: PreflightOutcome, detail: string): PreflightCheck {
  return { detail, name, outcome };
}

export function evaluatePreflight(input: PreflightInput): PreflightReport {
  const checks: PreflightCheck[] = [];
  const deployed = input.deploymentEnvironment !== 'development';

  // -- Identity ------------------------------------------------------------------------------
  checks.push(
    check(
      'deployment_environment',
      'pass',
      `resolved as ${input.deploymentEnvironment} from an explicit declaration`,
    ),
  );

  checks.push(
    deployed && !isExactReleaseSha(input.release)
      ? check(
          'release_is_exact_commit',
          'fail',
          'AVENLYO_RELEASE is not a full 40-character lowercase commit SHA',
        )
      : check(
          'release_is_exact_commit',
          deployed ? 'pass' : 'skip',
          deployed ? 'release is an exact commit' : 'not enforced outside a deployed environment',
        ),
  );

  // -- Schema --------------------------------------------------------------------------------
  if (input.schemaVersion === null) {
    checks.push(
      check('schema_compatible', 'skip', 'no schema probe was supplied to this preflight run'),
    );
  } else if (input.schemaVersion >= input.requiredSchemaVersion) {
    checks.push(
      check(
        'schema_compatible',
        'pass',
        `deployed schema satisfies the required minimum (>= ${input.requiredSchemaVersion})`,
      ),
    );
  } else {
    checks.push(
      check(
        'schema_compatible',
        'fail',
        `deployed schema is older than this build requires (>= ${input.requiredSchemaVersion})`,
      ),
    );
  }

  // -- Deployment configuration policy -------------------------------------------------------
  const findings = evaluateDeploymentConfig(input.config);
  const configErrors = findings.filter((finding) => finding.severity === 'error');
  if (configErrors.length === 0) {
    checks.push(check('deployment_configuration', 'pass', 'no cross-environment or scheme defects'));
  } else {
    for (const finding of configErrors) {
      checks.push(check(`config:${finding.check}`, 'fail', `${finding.setting} ${finding.detail}`));
    }
  }

  // -- Capabilities --------------------------------------------------------------------------
  // Partial fails everywhere: it is the state that breaks later rather than now.
  for (const name of input.capabilities.partial) {
    checks.push(
      check(`capability:${name}`, 'fail', 'is partially configured; complete it or unset it'),
    );
  }

  if (input.deploymentEnvironment === 'production') {
    for (const name of PRODUCTION_REQUIRED_CAPABILITIES) {
      const status = input.capabilities.capabilities[name];
      checks.push(
        status === 'configured'
          ? check(`capability:${name}`, 'pass', 'configured')
          : check(`capability:${name}`, 'fail', 'is required for a production deployment'),
      );
    }
  }

  for (const [name, status] of Object.entries(input.capabilities.capabilities)) {
    if (status !== 'disabled') continue;
    const required =
      input.deploymentEnvironment === 'production' &&
      PRODUCTION_REQUIRED_CAPABILITIES.includes(name as CapabilityName);
    if (!required) {
      checks.push(
        check(`capability:${name}`, 'pass', 'disabled, which is a supported deployment choice'),
      );
    }
  }

  // -- Supabase project identity -------------------------------------------------------------
  const assurance = supabaseIdentityAssurance({
    expectedProjectRef: input.expectedSupabaseProjectRef,
    supabaseUrl: input.supabaseUrl,
  });
  checks.push(
    check(
      'supabase_project_identity',
      assurance.status === 'mismatch' ? 'fail' : assurance.status === 'match' ? 'pass' : 'skip',
      assurance.detail,
    ),
  );

  const failed = checks.filter((entry) => entry.outcome === 'fail').map((entry) => entry.name);
  return {
    checks,
    deployment_environment: input.deploymentEnvironment,
    failed,
    ok: failed.length === 0,
    required_schema_version: input.requiredSchemaVersion,
    schema_version: input.schemaVersion,
  };
}

/** Bounded, fixed-width operator text. No value from the environment appears here. */
export function formatPreflightReport(report: PreflightReport): string {
  const lines = [
    'Avenlyo deployment preflight',
    `  environment      ${report.deployment_environment}`,
    `  schema           ${report.schema_version ?? 'not probed'} (requires >= ${report.required_schema_version})`,
    '',
  ];
  for (const entry of report.checks) {
    lines.push(`  ${entry.outcome.toUpperCase().padEnd(4)} ${entry.name.padEnd(38)} ${entry.detail}`);
  }
  lines.push('', report.ok ? '  RESULT: pass' : `  RESULT: fail (${report.failed.length})`, '');
  return lines.join('\n');
}
