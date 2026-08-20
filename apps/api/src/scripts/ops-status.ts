import { release, runtimeCapabilities } from '../env.js';
import { createServiceSupabaseClient } from '../lib/supabase.js';
import { buildOpsReport, formatOpsReport } from '../observability/ops-report.js';
import { REQUIRED_SCHEMA_VERSION } from '../observability/readiness.js';

/**
 * Trusted operator command. It is a CLI, not an HTTP route, because Avenlyo has tenant
 * authorization and no platform-staff role system: inventing a hidden super-admin surface would be
 * pretending to have security that does not exist. It reads global aggregates only and never prints
 * a credential, a connection string, or anything belonging to a customer.
 */

export const OPS_EXIT_OK = 0;
export const OPS_EXIT_DATABASE_UNAVAILABLE = 1;
export const OPS_EXIT_SCHEMA_INCOMPATIBLE = 2;

async function main(): Promise<number> {
  const asJson = process.argv.includes('--json');
  const supabase = createServiceSupabaseClient();
  if (!supabase) {
    process.stderr.write(
      'Trusted server Supabase configuration is required to read operational status.\n',
    );
    return OPS_EXIT_DATABASE_UNAVAILABLE;
  }

  const probe = await supabase.rpc('platform_readiness_probe');
  const probeRow = probe.data?.[0];
  if (probe.error || !probeRow) {
    // Deliberately no driver message: it can carry the database host and connection detail.
    process.stderr.write('The database did not answer the readiness probe.\n');
    return OPS_EXIT_DATABASE_UNAVAILABLE;
  }

  const [runtime, metrics] = await Promise.all([
    supabase.rpc('get_platform_runtime_status'),
    supabase.rpc('get_platform_operational_snapshot'),
  ]);
  if (runtime.error || metrics.error) {
    process.stderr.write('The database did not answer the operational snapshot.\n');
    return OPS_EXIT_DATABASE_UNAVAILABLE;
  }

  const report = buildOpsReport({
    capabilities: runtimeCapabilities,
    metrics: metrics.data ?? [],
    now: new Date(),
    requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
    runtime: runtime.data ?? [],
    schemaVersion: probeRow.schema_version,
  });

  process.stdout.write(
    asJson
      ? `${JSON.stringify({ ...report, cli_release: release }, null, 2)}\n`
      : `${formatOpsReport(report)}\n`,
  );

  return report.schema_compatible ? OPS_EXIT_OK : OPS_EXIT_SCHEMA_INCOMPATIBLE;
}

process.exitCode = await main();
