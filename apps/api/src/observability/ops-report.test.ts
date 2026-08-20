import type { PlatformOperationalMetricRow, PlatformRuntimeStatusRow } from '@avenlyo/database';
import { describe, expect, it } from 'vitest';

import { describeRuntimeCapabilities } from './capabilities.js';
import { buildOpsReport, formatOpsReport } from './ops-report.js';
import { evaluateSmokeCheck, smokeTargets, summarizeSmokeResults } from './smoke.js';

const NOW = new Date('2026-08-20T12:00:00.000Z');

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function runtimeRow(overrides: Partial<PlatformRuntimeStatusRow> = {}): PlatformRuntimeStatusRow {
  return {
    component: 'message_processing',
    component_state: 'running',
    consecutive_failures: 0,
    instance_id: '11111111-1111-4111-8111-111111111111',
    last_error_code: null,
    last_heartbeat_at: minutesAgo(0),
    last_success_at: minutesAgo(0),
    last_tick_at: minutesAgo(0),
    release: 'abc123',
    service: 'avenlyo-api',
    started_at: minutesAgo(30),
    stopped_at: null,
    ...overrides,
  };
}

function metric(
  overrides: Partial<PlatformOperationalMetricRow> = {},
): PlatformOperationalMetricRow {
  return {
    detail: null,
    metric: 'queued',
    metric_group: 'message_jobs',
    oldest_at: minutesAgo(3),
    value: 2,
    ...overrides,
  };
}

function reportFor(input: {
  readonly metrics?: readonly PlatformOperationalMetricRow[];
  readonly runtime?: readonly PlatformRuntimeStatusRow[];
  readonly schemaVersion?: number;
}) {
  return buildOpsReport({
    capabilities: describeRuntimeCapabilities({
      SUPABASE_ANON_KEY: 'anon',
      SUPABASE_SERVICE_ROLE_KEY: 'service',
      SUPABASE_URL: 'https://project.supabase.co',
    }),
    metrics: input.metrics ?? [],
    now: NOW,
    requiredSchemaVersion: 14,
    runtime: input.runtime ?? [],
    schemaVersion: input.schemaVersion ?? 14,
  });
}

describe('operational report', () => {
  it('groups component heartbeats under the instance that reported them', () => {
    const report = reportFor({
      runtime: [runtimeRow(), runtimeRow({ component: 'billing_events' })],
    });

    expect(report.runtime).toHaveLength(1);
    expect(report.runtime[0]?.components.map((component) => component.component)).toEqual([
      'billing_events',
      'message_processing',
    ]);
    expect(report.runtime[0]?.state).toBe('active');
  });

  it('keeps two replicas visible and never marks a stopped one active', () => {
    const report = reportFor({
      runtime: [
        runtimeRow(),
        runtimeRow({
          instance_id: '22222222-2222-4222-8222-222222222222',
          stopped_at: minutesAgo(5),
        }),
      ],
    });

    expect(report.runtime).toHaveLength(2);
    expect(report.runtime.map((instance) => instance.state).sort()).toEqual(['active', 'stopped']);
  });

  it('calls a silent component stale using a multiple of the heartbeat interval, not an invented SLA', () => {
    const report = reportFor({
      runtime: [runtimeRow({ last_heartbeat_at: minutesAgo(0), last_success_at: minutesAgo(30) })],
    });

    expect(report.runtime[0]?.components[0]?.stale).toBe(true);
    expect(report.runtime[0]?.components[0]?.last_success_age_seconds).toBe(1800);
  });

  it('does not call a fresh component stale', () => {
    const report = reportFor({ runtime: [runtimeRow()] });

    expect(report.runtime[0]?.components[0]?.stale).toBe(false);
  });

  it('reports schema incompatibility without hiding the numbers', () => {
    const behind = reportFor({ schemaVersion: 13 });
    const ahead = reportFor({ schemaVersion: 20 });

    expect(behind.schema_compatible).toBe(false);
    expect(ahead.schema_compatible).toBe(true);
  });

  it('renders configuration, runtime, and durable state for a human operator', () => {
    const output = formatOpsReport(
      reportFor({
        metrics: [
          metric(),
          metric({ metric: 'unknown', metric_group: 'sms_delivery', value: 1 }),
          metric({ metric: 'failed', metric_group: 'billing_events', value: 3 }),
        ],
        runtime: [runtimeRow({ consecutive_failures: 2, last_error_code: 'provider_timeout' })],
      }),
    );

    expect(output).toContain('supabase_core');
    expect(output).toContain('message_processing');
    expect(output).toContain('sms_delivery');
    expect(output).toContain('failures=2 (provider_timeout)');
  });

  it('prints nothing that could identify a customer, tenant, or provider record', () => {
    const output = formatOpsReport(
      reportFor({
        metrics: [metric(), metric({ metric_group: 'billing_events', metric: 'pending' })],
        runtime: [runtimeRow()],
      }),
    );

    for (const forbidden of [
      'phone',
      'email',
      'contact',
      'transcript',
      'customer',
      'organization_id',
      'location_id',
      'access_token',
      'refresh_token',
      'sk_',
      'whsec_',
    ]) {
      expect(output.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('production smoke checks', () => {
  it('checks API liveness and readiness, and web liveness only when a web URL is given', () => {
    expect(smokeTargets({ apiBaseUrl: 'https://api.example.com/' })).toEqual([
      { name: 'api_live', url: 'https://api.example.com/health/live' },
      { name: 'api_ready', url: 'https://api.example.com/health/ready' },
    ]);
    expect(
      smokeTargets({
        apiBaseUrl: 'https://api.example.com',
        webBaseUrl: 'https://app.example.com/',
      }),
    ).toHaveLength(3);
  });

  it('accepts only the exact healthy contract', () => {
    expect(evaluateSmokeCheck('api_live', { body: { status: 'ok' }, status: 200 }).ok).toBe(true);
    expect(evaluateSmokeCheck('api_ready', { body: { status: 'ready' }, status: 200 }).ok).toBe(
      true,
    );
    // A ready endpoint that merely returns 200 with the wrong body is not a pass.
    expect(evaluateSmokeCheck('api_ready', { body: { status: 'ok' }, status: 200 })).toMatchObject({
      detail: 'status_ok',
      ok: false,
    });
    expect(
      evaluateSmokeCheck('api_ready', { body: { status: 'not_ready' }, status: 503 }),
    ).toMatchObject({ detail: 'http_503', ok: false });
    expect(evaluateSmokeCheck('api_live', null)).toMatchObject({
      detail: 'unreachable',
      ok: false,
    });
  });

  it('fails the run when any single check failed', () => {
    const summary = summarizeSmokeResults([
      { detail: 'ok', name: 'api_live', ok: true },
      { detail: 'http_503', name: 'api_ready', ok: false },
    ]);

    expect(summary).toEqual({ failed: ['api_ready'], ok: false });
  });
});
