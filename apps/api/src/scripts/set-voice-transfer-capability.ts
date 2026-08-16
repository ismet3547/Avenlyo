import { z } from 'zod';

import { env } from '../env.js';
import { createVoiceServiceSupabaseClient } from '../lib/supabase.js';

const argumentsSchema = z.object({
  enabled: z.enum(['true', 'false']),
  location: z.string().uuid(),
  organization: z.string().uuid(),
});

function parseArguments(argv: readonly string[]): z.infer<typeof argumentsSchema> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value) throw new Error('Invalid command arguments.');
    values[flag.slice(2)] = value;
  }
  const parsed = argumentsSchema.safeParse(values);
  if (!parsed.success) {
    throw new Error(
      'Usage: voice:set-transfer-capability --organization <uuid> --location <uuid> --enabled <true|false>',
    );
  }
  return parsed.data;
}

async function main(): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for operations.');
  }
  const input = parseArguments(process.argv.slice(2));
  const supabase = createVoiceServiceSupabaseClient();
  if (!supabase) throw new Error('Voice service client is unavailable.');
  const { error } = await supabase.rpc('set_voice_provider_transfer_capability', {
    target_enabled: input.enabled === 'true',
    target_location_id: input.location,
    target_organization_id: input.organization,
  });
  if (error) throw new Error('Transfer capability update failed.');
  process.stdout.write(
    `Transfer capability set to ${input.enabled} for location ${input.location}.\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Transfer capability update failed.'}\n`,
  );
  process.exitCode = 1;
});
