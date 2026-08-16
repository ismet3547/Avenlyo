export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type MemberRole = 'owner' | 'admin' | 'member';
export type OnboardingStatus = 'in_progress' | 'completed';
export type OnboardingStep =
  'industry' | 'business' | 'location' | 'website' | 'review' | 'completed';

export interface BootstrapWorkspaceRow {
  organization_id: string;
  location_id: string;
  current_step: OnboardingStep;
}

export interface TenantContextRow {
  organization_id: string;
  organization_name: string;
  primary_industry_id: string | null;
  website_url: string | null;
  business_phone: string | null;
  membership_id: string;
  membership_role: MemberRole;
  location_id: string | null;
  location_name: string | null;
  location_timezone: string | null;
  location_address: Json | null;
  business_hours: Json | null;
  onboarding_status: OnboardingStatus | null;
  onboarding_step: OnboardingStep | null;
  onboarding_completed_at: string | null;
}

type EmptyRecord = Record<never, never>;

export interface Database {
  public: {
    Tables: EmptyRecord;
    Views: EmptyRecord;
    Functions: {
      advance_onboarding_website: {
        Args: EmptyRecord;
        Returns: OnboardingStep;
      };
      bootstrap_workspace: {
        Args: EmptyRecord;
        Returns: BootstrapWorkspaceRow[];
      };
      complete_onboarding: {
        Args: EmptyRecord;
        Returns: string;
      };
      get_my_tenant_context: {
        Args: EmptyRecord;
        Returns: TenantContextRow[];
      };
      save_onboarding_business: {
        Args: {
          business_name: string;
          business_website_url: string | null;
          normalized_business_phone: string | null;
        };
        Returns: OnboardingStep;
      };
      save_onboarding_industry: {
        Args: { selected_industry_id: string };
        Returns: OnboardingStep;
      };
      save_onboarding_location: {
        Args: {
          location_address: Json;
          location_business_hours: Json;
          location_name: string;
          location_timezone: string;
        };
        Returns: OnboardingStep;
      };
    };
    Enums: EmptyRecord;
    CompositeTypes: EmptyRecord;
  };
}
