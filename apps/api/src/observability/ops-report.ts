import type { PlatformOperationalMetricRow, PlatformRuntimeStatusRow } from '@avenlyo/database';

import type { CapabilityReport, CapabilityStatus } from './capabilities.js';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from './heartbeat.js';

/**
 * Formatting for the trusted operator command.
 *
 * Everything here is a global aggregate. No tenant identifier, contact, phone number, message body,
 * or provider identifier reaches this module, because the snapshot RPC does not return any. The
 * formatter is pure so its output can be asserted directly in tests.
 */

/**
 * A component whose heartbeat is older than several intervals is a runtime failure signal, not a
 * customer service level. The multiple is deterministic and derived from the configured interval.
 */
export const STALE_HEARTBEAT_INTERVAL_MULTIPLE = 4;

export interface OpsReportInput {
  readonly capabilities: CapabilityReport;
  readonly heartbeatIntervalMs?: number;
  readonly metrics: readonly PlatformOperationalMetricRow[];
  readonly now: Date;
  readonly requiredSchemaVersion: number;
  readonly runtime: readonly PlatformRuntimeStatusRow[];
  readonly schemaVersion: number;
}

export interface OpsReport {
  readonly capabilities: Readonly<Record<string, CapabilityStatus>>;
  readonly generated_at: string;
  readonly metrics: readonly PlatformOperationalMetricRow[];
  readonly required_schema_version: number;
  readonly runtime: readonly OpsRuntimeInstance[];
  readonly schema_compatible: boolean;
  readonly schema_version: number;
}

export interface OpsRuntimeInstance {
  readonly components: readonly OpsRuntimeComponent[];
  readonly instance_id: string;
  readonly release: string;
  readonly started_at: string;
  readonly state: 'active' | 'stale' | 'stopped';
}

export interface OpsRuntimeComponent {
  readonly component: string;
  readonly consecutive_failures: number;
  readonly last_error_code: string | null;
  readonly last_success_age_seconds: number | null;
  readonly stale: boolean;
  readonly state: string;
}

function ageSeconds(now: Date, value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.round((now.getTime() - parsed) / 1000));
}

export function buildOpsReport(input: OpsReportInput): OpsReport {
  const intervalMs = input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const staleAfterSeconds = (intervalMs * STALE_HEARTBEAT_INTERVAL_MULTIPLE) / 1000;
  const byInstance = new Map<string, PlatformRuntimeStatusRow[]>();
  for (const row of input.runtime) {
    const rows = byInstance.get(row.instance_id) ?? [];
    rows.push(row);
    byInstance.set(row.instance_id, rows);
  }

  const runtime: OpsRuntimeInstance[] = [];
  for (const [instanceId, rows] of byInstance) {
    const head = rows[0];
    if (!head) continue;
    const heartbeatAge = ageSeconds(input.now, head.last_heartbeat_at);
    // A process that stopped on purpose is never reported as active, and a process that simply
    // stopped reporting is called stale rather than quietly disappearing.
    const state: OpsRuntimeInstance['state'] = head.stopped_at
      ? 'stopped'
      : heartbeatAge !== null && heartbeatAge > staleAfterSeconds
        ? 'stale'
        : 'active';
    const components = rows
      .filter((row): row is PlatformRuntimeStatusRow & { component: string } =>
        Boolean(row.component),
      )
      .map((row) => {
        const successAge = ageSeconds(input.now, row.last_success_at);
        return {
          component: row.component,
          consecutive_failures: row.consecutive_failures ?? 0,
          last_error_code: row.last_error_code,
          last_success_age_seconds: successAge,
          stale:
            state === 'active' &&
            row.component_state === 'running' &&
            (successAge === null || successAge > staleAfterSeconds),
          state: row.component_state ?? 'unknown',
        };
      })
      .sort((left, right) => left.component.localeCompare(right.component));
    runtime.push({
      components,
      instance_id: instanceId,
      release: head.release,
      started_at: head.started_at,
      state,
    });
  }

  return {
    capabilities: input.capabilities.capabilities,
    generated_at: input.now.toISOString(),
    metrics: input.metrics,
    required_schema_version: input.requiredSchemaVersion,
    runtime: runtime.sort((left, right) => right.started_at.localeCompare(left.started_at)),
    schema_compatible: input.schemaVersion >= input.requiredSchemaVersion,
    schema_version: input.schemaVersion,
  };
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function formatOpsReport(report: OpsReport): string {
  const lines: string[] = [];
  lines.push('Avenlyo operational status');
  lines.push(`  generated        ${report.generated_at}`);
  lines.push(
    `  schema           ${report.schema_version} (requires >= ${report.required_schema_version})` +
      `${report.schema_compatible ? '' : '  INCOMPATIBLE'}`,
  );

  lines.push('');
  lines.push('Configuration');
  for (const [capability, status] of Object.entries(report.capabilities)) {
    lines.push(`  ${capability.padEnd(18)} ${status}${status === 'partial' ? '  REVIEW' : ''}`);
  }

  lines.push('');
  lines.push('Runtime');
  if (report.runtime.length === 0) {
    lines.push('  no runtime instance has reported');
  }
  for (const instance of report.runtime) {
    lines.push(`  ${instance.instance_id}  ${instance.state}  release=${instance.release}`);
    for (const component of instance.components) {
      const failures =
        component.consecutive_failures > 0
          ? `  failures=${component.consecutive_failures}` +
            (component.last_error_code ? ` (${component.last_error_code})` : '')
          : '';
      lines.push(
        `    ${component.component.padEnd(22)} ${component.state.padEnd(9)} ` +
          `success ${formatAge(component.last_success_age_seconds)}` +
          `${component.stale ? '  STALE' : ''}${failures}`,
      );
    }
  }

  lines.push('');
  lines.push('Durable state');
  if (report.metrics.length === 0) {
    lines.push('  nothing waiting');
  }
  let currentGroup = '';
  for (const metric of report.metrics) {
    if (metric.metric_group !== currentGroup) {
      currentGroup = metric.metric_group;
      lines.push(`  ${currentGroup}`);
    }
    const oldest = metric.oldest_at ? `  oldest ${metric.oldest_at}` : '';
    const detail = metric.detail ? `  ${metric.detail}` : '';
    lines.push(
      `    ${metric.metric.padEnd(34)} ${String(metric.value).padStart(6)}${detail}${oldest}`,
    );
  }

  return lines.join('\n');
}
