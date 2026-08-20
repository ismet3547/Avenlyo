import { release, runtimeCapabilities } from '../env.js';
import { createServiceSupabaseClient } from '../lib/supabase.js';
import { buildOpsReport, formatOpsReport } from '../observability/ops-report.js';
import { REQUIRED_SCHEMA_VERSION } from '../observability/readiness.js';

/**
 * Trusted operator command. It is a CLI, not an HTTP route, because Avenlyo has tenant
 * authorization and no platform-staff role system: inventing a hidden super-admin surface would be
 * pretending to have security that does not exist. It reads global aggregates only and never prints
 * a credential, a connection string, or anything belonging to a customer.
 *
 * Every database call goes through one boundary that converts a thrown transport failure into the
 * same fixed message a returned error produces. Without it, a rejected RPC propagated to Node's
 * default handler, which prints the message and stack of an error whose text routinely contains the
 * database hostname, the full connection URL, and occasionally credential fragments.
 */

export const OPS_EXIT_OK = 0;
export const OPS_EXIT_DATABASE_UNAVAILABLE = 1;
export const OPS_EXIT_SCHEMA_INCOMPATIBLE = 2;

/** Fixed operator-facing text. Never interpolates a driver message, host, or error object. */
const DATABASE_UNAVAILABLE_MESSAGE = 'The database did not answer the readiness probe.\n';
const SNAPSHOT_UNAVAILABLE_MESSAGE = 'The database did not answer the operational snapshot.\n';

export interface OpsStatusIo {
  readonly argv?: readonly string[];
  readonly stderr?: (text: string) => void;
  readonly stdout?: (text: string) => void;
}

export async function runOpsStatus(io: OpsStatusIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => void process.stderr.write(text));
  const argv = io.argv ?? process.argv;

  try {
    const asJson = argv.includes('--json');
    const supabase = createServiceSupabaseClient();
    if (!supabase) {
      stderr('Trusted server Supabase configuration is required to read operational status.\n');
      return OPS_EXIT_DATABASE_UNAVAILABLE;
    }

    const probe = await supabase.rpc('platform_readiness_probe');
    const probeRow = probe.data?.[0];
    if (probe.error || !probeRow) {
      // Deliberately no driver message: it can carry the database host and connection detail.
      stderr(DATABASE_UNAVAILABLE_MESSAGE);
      return OPS_EXIT_DATABASE_UNAVAILABLE;
    }

    const [runtime, metrics] = await Promise.all([
      supabase.rpc('get_platform_runtime_status'),
      supabase.rpc('get_platform_operational_snapshot'),
    ]);
    if (runtime.error || metrics.error) {
      stderr(SNAPSHOT_UNAVAILABLE_MESSAGE);
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

    stdout(
      asJson
        ? `${JSON.stringify({ ...report, cli_release: release }, null, 2)}\n`
        : `${formatOpsReport(report)}\n`,
    );

    return report.schema_compatible ? OPS_EXIT_OK : OPS_EXIT_SCHEMA_INCOMPATIBLE;
  } catch (error) {
    // A rejected RPC and a returned error mean the same thing to an operator, and the thrown value
    // is never inspected, formatted, or printed: its message is exactly where a hostname or
    // credential fragment would be.
    void error;
    stderr(DATABASE_UNAVAILABLE_MESSAGE);
    return OPS_EXIT_DATABASE_UNAVAILABLE;
  }
}

// Importing this module for a test must not run the command, and running it must not leave a
// rejected promise for Node to print.
if (process.argv[1]?.includes('ops-status')) {
  process.exitCode = await runOpsStatus();
}
