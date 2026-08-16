import type { BusinessHours } from '@avenlyo/shared';
import type { MemberRole, OnboardingStatus, OnboardingStep } from '@avenlyo/database';

export interface LocationAddress {
  street?: string | undefined;
  city?: string | undefined;
  region?: string | undefined;
  postalCode?: string | undefined;
  countryCode?: string | undefined;
}

export interface TenantContext {
  organizationId: string;
  organizationName: string;
  primaryIndustryId: string | null;
  websiteUrl: string | null;
  businessPhone: string | null;
  membershipId: string;
  role: MemberRole;
  locationId: string | null;
  locationName: string | null;
  locationTimezone: string | null;
  locationAddress: LocationAddress;
  businessHours: BusinessHours | null;
  onboardingStatus: OnboardingStatus | null;
  onboardingStep: OnboardingStep | null;
  onboardingCompletedAt: string | null;
}
