import { agentPricingVersion } from '@avenlyo/ai';
import { z } from 'zod';

import { deploymentEnvironment, env, release } from '../env.js';
import { scenarios } from './dental-agent-acceptance-scenarios.js';
import { loadBusinessSnapshot } from './dental-agent-acceptance-business.js';
import { runScenario, type DentalAcceptanceCaseResult } from './dental-agent-acceptance-runtime.js';

/** Staging-only operator CLI. The runtime module contains the read-only execution boundary. */
export const DENTAL_ACCEPTANCE_EXIT_OK = 0;
export const DENTAL_ACCEPTANCE_EXIT_FAILED = 1;
export const DENTAL_ACCEPTANCE_EXIT_CONFIGURATION = 2;
const UUID = z.string().uuid();

function argumentValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
}

function parseLocationId(argv: readonly string[]): string | null {
  const parsed = UUID.safeParse(argumentValue(argv, '--location-id'));
  return parsed.success ? parsed.data : null;
}

function formatReport(locationId: string, results: readonly DentalAcceptanceCaseResult[]): string {
  const lines = [
    'Avenlyo dental agent acceptance',
    `  release          ${release}`,
    `  location         ${locationId}`,
    `  pricing          ${agentPricingVersion}`,
    '',
  ];
  for (const result of results) {
    const status = result.failures.length === 0 ? 'PASS' : 'FAIL';
    const tokens = `${result.inputTokens}/${result.cachedInputTokens}/${result.outputTokens}`;
    const cost =
      result.costMicrousd === null
        ? 'route-only'
        : `$${(result.costMicrousd / 1_000_000).toFixed(6)}`;
    lines.push(
      `  ${status} ${result.id.padEnd(26)} tier=${result.tier.padEnd(13)} model=${result.model} reason=${result.reason} tokens=${tokens} cost=${cost}`,
    );
    if (result.failures.length) lines.push(`       checks=${result.failures.join(',')}`);
  }
  const passed = results.filter((result) => result.failures.length === 0).length;
  lines.push(
    '',
    `  RESULT: ${passed === results.length ? 'pass' : 'fail'} (${passed}/${results.length})`,
    '',
  );
  return lines.join('\n');
}

export async function runDentalAgentAcceptance(
  argv: readonly string[] = process.argv,
): Promise<number> {
  if (deploymentEnvironment !== 'staging') {
    process.stderr.write('Dental agent acceptance is staging-only.\n');
    return DENTAL_ACCEPTANCE_EXIT_CONFIGURATION;
  }
  const locationId = parseLocationId(argv);
  if (!locationId) {
    process.stderr.write('Usage: dental-agent-acceptance --location-id <uuid> [--json]\n');
    return DENTAL_ACCEPTANCE_EXIT_CONFIGURATION;
  }
  if (!env.OPENAI_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    process.stderr.write('Dental agent acceptance dependencies are not configured.\n');
    return DENTAL_ACCEPTANCE_EXIT_CONFIGURATION;
  }
  try {
    const snapshot = await loadBusinessSnapshot(locationId);
    const results: DentalAcceptanceCaseResult[] = [];
    for (const scenario of scenarios)
      results.push(await runScenario(scenario, snapshot, env.OPENAI_API_KEY));
    process.stdout.write(
      argv.includes('--json')
        ? `${JSON.stringify({ locationId, pricingVersion: agentPricingVersion, release, results }, null, 2)}\n`
        : formatReport(locationId, results),
    );
    return results.every((result) => result.failures.length === 0)
      ? DENTAL_ACCEPTANCE_EXIT_OK
      : DENTAL_ACCEPTANCE_EXIT_FAILED;
  } catch (error) {
    const known = new Set([
      'backend_not_configured',
      'business_snapshot_unavailable',
      'knowledge_search_failed',
      'not_dental',
    ]);
    const stage = error instanceof Error && known.has(error.message) ? error.message : 'unexpected';
    process.stderr.write(`Dental agent acceptance could not complete safely. stage=${stage}\n`);
    return DENTAL_ACCEPTANCE_EXIT_CONFIGURATION;
  }
}

if (process.argv[1]?.includes('dental-agent-acceptance'))
  process.exitCode = await runDentalAgentAcceptance();
