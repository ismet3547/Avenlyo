import type { Json } from '@avenlyo/database';
import { businessHoursSchema, type BusinessDetails, type LocationDetails } from '@avenlyo/shared';
import { z } from 'zod';

import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

import { ensureSingleTenantContext } from './routing';
import type { TenantContext } from './types';

interface OnboardingRpcCaller {
  (name: 'get_my_tenant_context'): PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
  }>;
  (name: 'bootstrap_workspace'): PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
  }>;
  (
    name: 'save_onboarding_industry',
    args: { selected_industry_id: string },
  ): PromiseLike<{ data: string | null; error: { message: string } | null }>;
  (
    name: 'save_onboarding_business',
    args: {
      business_name: string;
      business_website_url: string | null;
      normalized_business_phone: string | null;
    },
  ): PromiseLike<{ data: string | null; error: { message: string } | null }>;
  (
    name: 'save_onboarding_location',
    args: {
      location_address: Json;
      location_business_hours: Json;
      location_name: string;
      location_timezone: string;
    },
  ): PromiseLike<{ data: string | null; error: { message: string } | null }>;
  (name: 'advance_onboarding_website'): PromiseLike<{
    data: string | null;
    error: { message: string } | null;
  }>;
  (name: 'complete_onboarding'): PromiseLike<{
    data: string | null;
    error: { message: string } | null;
  }>;
}

function onboardingRpc(client: AvenlyoSupabaseClient): OnboardingRpcCaller {
  // @supabase/ssr 0.6 resolves an older generic client signature than the current
  // generated database contract. Keep this compatibility cast isolated here.
  return client.rpc.bind(client);
}

const tenantContextRowSchema = z.object({
  organization_id: z.string().uuid(),
  organization_name: z.string(),
  primary_industry_id: z.string().nullable(),
  website_url: z.string().nullable(),
  business_phone: z.string().nullable(),
  membership_id: z.string().uuid(),
  membership_role: z.enum(['owner', 'admin', 'member']),
  location_id: z.string().uuid().nullable(),
  location_name: z.string().nullable(),
  location_timezone: z.string().nullable(),
  location_address: z.unknown().nullable(),
  business_hours: z.unknown().nullable(),
  onboarding_status: z.enum(['in_progress', 'completed']).nullable(),
  onboarding_step: z
    .enum(['industry', 'business', 'location', 'website', 'review', 'completed'])
    .nullable(),
  onboarding_completed_at: z.string().nullable(),
});

const databaseAddressSchema = z
  .object({
    street: z.string().optional(),
    city: z.string().optional(),
    region: z.string().optional(),
    postal_code: z.string().optional(),
    country_code: z.string().optional(),
  })
  .catch({});

export class OnboardingServiceError extends Error {
  public constructor(operation: string) {
    super(`The onboarding ${operation} could not be completed.`);
    this.name = 'OnboardingServiceError';
  }
}

function mapTenantContext(input: unknown): TenantContext {
  const row = tenantContextRowSchema.parse(input);
  const address = databaseAddressSchema.parse(row.location_address ?? {});
  const hoursResult = businessHoursSchema.safeParse(row.business_hours);

  return {
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    primaryIndustryId: row.primary_industry_id,
    websiteUrl: row.website_url,
    businessPhone: row.business_phone,
    membershipId: row.membership_id,
    role: row.membership_role,
    locationId: row.location_id,
    locationName: row.location_name,
    locationTimezone: row.location_timezone,
    locationAddress: {
      street: address.street,
      city: address.city,
      region: address.region,
      postalCode: address.postal_code,
      countryCode: address.country_code,
    },
    businessHours: hoursResult.success ? hoursResult.data : null,
    onboardingStatus: row.onboarding_status,
    onboardingStep: row.onboarding_step,
    onboardingCompletedAt: row.onboarding_completed_at,
  };
}

async function requireSuccessfulRpc<Result>(
  operation: string,
  request: PromiseLike<{ data: Result | null; error: { message: string } | null }>,
): Promise<Result> {
  const { data, error } = await request;

  if (error || data === null) {
    throw new OnboardingServiceError(operation);
  }

  return data;
}

export async function loadTenantContexts(
  supabase: AvenlyoSupabaseClient,
): Promise<TenantContext[]> {
  const rows = await requireSuccessfulRpc(
    'workspace lookup',
    onboardingRpc(supabase)('get_my_tenant_context'),
  );
  return z.array(tenantContextRowSchema).parse(rows).map(mapTenantContext);
}

export async function ensureWorkspaceContext(
  supabase: AvenlyoSupabaseClient,
): Promise<TenantContext> {
  return ensureSingleTenantContext(
    () => loadTenantContexts(supabase),
    async () => {
      await requireSuccessfulRpc('workspace setup', onboardingRpc(supabase)('bootstrap_workspace'));
    },
  );
}

export async function saveIndustry(
  supabase: AvenlyoSupabaseClient,
  industryId: string,
): Promise<void> {
  await requireSuccessfulRpc(
    'industry update',
    onboardingRpc(supabase)('save_onboarding_industry', { selected_industry_id: industryId }),
  );
}

export async function saveBusiness(
  supabase: AvenlyoSupabaseClient,
  details: BusinessDetails,
): Promise<void> {
  await requireSuccessfulRpc(
    'business update',
    onboardingRpc(supabase)('save_onboarding_business', {
      business_name: details.name,
      business_website_url: details.websiteUrl ?? null,
      normalized_business_phone: details.phone ?? null,
    }),
  );
}

export async function saveLocation(
  supabase: AvenlyoSupabaseClient,
  details: LocationDetails,
): Promise<void> {
  const address: Json = {
    street: details.street,
    city: details.city,
    region: details.region,
    postal_code: details.postalCode,
    country_code: details.countryCode,
  };

  await requireSuccessfulRpc(
    'location update',
    onboardingRpc(supabase)('save_onboarding_location', {
      location_address: address,
      location_business_hours: details.businessHours,
      location_name: details.name,
      location_timezone: details.timezone,
    }),
  );
}

export async function continueWebsitePreview(supabase: AvenlyoSupabaseClient): Promise<void> {
  await requireSuccessfulRpc(
    'website preview',
    onboardingRpc(supabase)('advance_onboarding_website'),
  );
}

export async function finishOnboarding(supabase: AvenlyoSupabaseClient): Promise<void> {
  await requireSuccessfulRpc('completion', onboardingRpc(supabase)('complete_onboarding'));
}
