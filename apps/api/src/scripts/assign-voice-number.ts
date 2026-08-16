import { normalizeE164 } from '@avenlyo/voice';
import { z } from 'zod';

import { env } from '../env.js';
import { createVoiceServiceSupabaseClient } from '../lib/supabase.js';

const argumentsSchema = z.object({
  label: z.string().trim().max(120).optional(),
  location: z.string().uuid(),
  number: z.string(),
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
      'Usage: voice:assign-number --organization <uuid> --location <uuid> --number <E.164> [--label <label>]',
    );
  }
  const number = normalizeE164(parsed.data.number);
  if (!number) throw new Error('Number must be canonical E.164, for example +14155550123.');
  return { ...parsed.data, number };
}

async function main(): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for ops assignment.');
  }
  const input = parseArguments(process.argv.slice(2));
  const supabase = createVoiceServiceSupabaseClient();
  if (!supabase) throw new Error('Voice service client is unavailable.');
  const { data, error } = await supabase.rpc('assign_voice_phone_number', {
    target_label: input.label ?? null,
    target_location_id: input.location,
    target_organization_id: input.organization,
    target_phone_number: input.number,
  });
  if (error || !data[0]) throw new Error('Phone number assignment failed.');
  process.stdout.write(`Assigned ${data[0].phone_number} to location ${input.location}.\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Phone number assignment failed.'}\n`,
  );
  process.exitCode = 1;
});
