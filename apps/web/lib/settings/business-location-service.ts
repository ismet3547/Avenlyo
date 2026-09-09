import type { Json } from '@avenlyo/database';
import type { BusinessDetails, LocationDetails } from '@avenlyo/shared';

import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

export class BusinessLocationSettingsError extends Error {
  public constructor() {
    super('Business or location settings could not be saved.');
    this.name = 'BusinessLocationSettingsError';
  }
}

function ensureExactRow(
  expectedId: string,
  result: { data: { id: string } | null; error: unknown },
): void {
  if (result.error || result.data?.id !== expectedId) {
    throw new BusinessLocationSettingsError();
  }
}

/**
 * User-initiated configuration update. The caller supplies only the trusted organization identity
 * resolved from the active workspace; no organization id ever comes from the submitted form.
 */
export async function updateBusinessSettings(
  supabase: AvenlyoSupabaseClient,
  organizationId: string,
  details: BusinessDetails,
): Promise<void> {
  const result = await supabase
    .from('organizations')
    .update({
      business_phone: details.phone ?? null,
      name: details.name,
      website_url: details.websiteUrl ?? null,
    })
    .eq('id', organizationId)
    .select('id')
    .maybeSingle();

  ensureExactRow(organizationId, result);
}

/**
 * Updates one already-authorized active location. RLS remains the database authority and the
 * organization predicate prevents a stale/tampered location id from crossing tenant boundaries.
 */
export async function updateLocationSettings(
  supabase: AvenlyoSupabaseClient,
  organizationId: string,
  locationId: string,
  details: LocationDetails,
): Promise<void> {
  const address: Json = {
    city: details.city,
    country_code: details.countryCode,
    postal_code: details.postalCode,
    region: details.region,
    street: details.street,
  };

  const result = await supabase
    .from('locations')
    .update({
      address,
      business_hours: details.businessHours,
      name: details.name,
      timezone: details.timezone,
    })
    .eq('organization_id', organizationId)
    .eq('id', locationId)
    .select('id')
    .maybeSingle();

  ensureExactRow(locationId, result);
}
