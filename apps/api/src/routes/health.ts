import type { FastifyPluginCallback } from 'fastify';

import { env, release, runtimeCapabilities } from '../env.js';
import { createServiceSupabaseClient } from '../lib/supabase.js';
import { classifyError } from '../observability/errors.js';
import {
  evaluateReadiness,
  type DatabaseProbeResult,
  type ReadinessResult,
} from '../observability/readiness.js';
import type { RuntimeState } from '../observability/runtime-state.js';

export interface HealthRoutesOptions {
  /** Injected in tests; production uses the process runtime state. */
  readonly probeDatabase?: () => Promise<DatabaseProbeResult>;
  readonly runtimeState?: RuntimeState;
}

interface ReadinessProbeRow {
  readonly checked_at: string;
  readonly schema_version: number;
}

/**
 * One cheap round trip. Queue aggregation deliberately does not happen here: a load balancer may
 * call readiness many times a second, and operational aggregates belong to `ops:status`.
 */
async function probeDatabaseThroughRpc(): Promise<DatabaseProbeResult> {
  const supabase = createServiceSupabaseClient();
  if (!supabase) return { ok: false };
  try {
    const { data, error } = await supabase.rpc('platform_readiness_probe');
    const row = (data as readonly ReadinessProbeRow[] | null)?.[0];
    if (error || !row || typeof row.schema_version !== 'number') return { ok: false };
    return { ok: true, schemaVersion: row.schema_version };
  } catch {
    return { ok: false };
  }
}

export const healthRoutes: FastifyPluginCallback<HealthRoutesOptions> = (app, options, done) => {
  const probe = options.probeDatabase ?? probeDatabaseThroughRpc;

  // Liveness must stay free of every dependency: it answers "is this process serving HTTP".
  const liveness = () => ({
    release,
    service: 'avenlyo-api',
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
  });

  // The original Phase 0 endpoint keeps its exact contract so existing probes do not change
  // meaning and never become provider dependent.
  app.get('/health', liveness);
  app.get('/health/live', liveness);

  app.get('/health/ready', async (request, reply) => {
    const runtimeState = options.runtimeState;
    let result: ReadinessResult;
    try {
      const databaseConfigured =
        runtimeCapabilities.capabilities.supabase_core === 'configured' &&
        Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
      result = evaluateReadiness({
        capabilities: runtimeCapabilities,
        draining: runtimeState?.isDraining() ?? false,
        probe: databaseConfigured ? await probe() : null,
        schedulerFailures: runtimeState?.schedulerFailures() ?? [],
      });
    } catch (error) {
      request.log.error(
        { component: 'health', error_code: classifyError(error), operation: 'readiness' },
        'Readiness evaluation failed.',
      );
      result = { ready: false, reasons: ['database_unavailable'], schemaVersion: null };
    }

    if (!result.ready) {
      // Detail is for sanitized server logs and the trusted operator CLI only. The public body
      // never names a dependency, a component, or a configuration state.
      request.log.warn(
        {
          component: 'health',
          operation: 'readiness',
          outcome: 'not_ready',
          reasons: result.reasons,
          schema_version: result.schemaVersion,
        },
        'Readiness check failed.',
      );
    }

    return reply.code(result.ready ? 200 : 503).send({
      release,
      request_id: String(request.id),
      service: 'avenlyo-api',
      status: result.ready ? 'ready' : 'not_ready',
    });
  });

  done();
};
