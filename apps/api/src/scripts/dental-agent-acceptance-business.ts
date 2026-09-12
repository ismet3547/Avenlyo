import type { AgentBusinessContext } from '@avenlyo/ai';
import { z } from 'zod';

import { createServiceSupabaseClient } from '../lib/supabase.js';

const UUID = z.string().uuid();
const businessContextRowSchema = z.object({
  business_hours: z.unknown().nullable(),
  business_phone: z.string().nullable(),
  location_address: z.unknown().nullable(),
  location_id: UUID,
  location_name: z.string().min(1),
  location_timezone: z.string().min(1),
  organization_id: UUID,
  organization_name: z.string().min(1),
  primary_industry_id: z.string().nullable(),
  website_url: z.string().nullable(),
});


export interface BusinessSnapshot {
  readonly business: AgentBusinessContext;
  readonly locationId: string;
  readonly organizationId: string;
}

export async function loadBusinessSnapshot(locationId: string): Promise<BusinessSnapshot> {
  const supabase = createServiceSupabaseClient();
  if (!supabase) throw new Error('backend_not_configured');
  type BusinessContextRpc = (
    name: 'get_agent_location_business_context',
    args: { target_location_id: string },
  ) => PromiseLike<{ data: unknown[] | null; error: unknown }>;
  const rpc = supabase.rpc.bind(supabase) as unknown as BusinessContextRpc;
  const { data, error } = await rpc('get_agent_location_business_context', {
    target_location_id: locationId,
  });
  if (error) throw new Error('business_snapshot_unavailable');
  const parsed = businessContextRowSchema.safeParse(data?.[0]);
  if (!parsed.success) throw new Error('business_snapshot_unavailable');
  const row = parsed.data;
  if (row.primary_industry_id !== 'dental') throw new Error('not_dental');
  return {
    business: {
      address: row.location_address === null ? null : JSON.stringify(row.location_address),
      businessHours: row.business_hours === null ? null : JSON.stringify(row.business_hours),
      locationName: row.location_name,
      name: row.organization_name,
      phone: row.business_phone,
      timezone: row.location_timezone,
      website: row.website_url,
    },
    locationId: row.location_id,
    organizationId: row.organization_id,
  };
}

