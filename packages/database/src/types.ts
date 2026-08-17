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

export interface KnowledgeImportRow {
  import_id: string;
  status: string;
}

export interface KnowledgeOverviewRow {
  import_id: string;
  root_url: string;
  status: string;
  pages_discovered: number;
  pages_imported: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  draft_documents: number;
  ready_documents: number;
}

export interface KnowledgeReviewRow {
  document_id: string;
  title: string;
  canonical_url: string;
  content: string;
  included: boolean;
  status: string;
}

export interface KnowledgePublicationSnapshotRow {
  document_id: string;
  title: string;
  content: string;
  content_hash: string;
  source_url: string;
}

export interface KnowledgeMatchRow {
  chunk_id: string;
  document_id: string;
  title: string;
  source_url: string;
  content: string;
  similarity: number;
}

export interface AgentTestConversationRow {
  conversation_id: string;
  created_at: string;
}

export interface AgentTestRunRow {
  run_id: string;
  is_existing: boolean;
  status: 'running' | 'completed' | 'failed';
}

export interface AgentTestMessageRow {
  message_id: string;
  body: string | null;
  direction: 'inbound' | 'outbound' | 'internal';
  metadata: Json;
  created_at: string;
}

export interface AgentTestHandoffRow {
  handoff_id: string;
  created: boolean;
}

export interface AgentTestTurnResultRow {
  run_id: string;
  status: 'running' | 'completed' | 'failed';
  failure_code: string | null;
  model: string;
  assistant_body: string | null;
  source_references: Json;
  tool_executions: Json;
  handoff_requested: boolean;
}

export interface VoiceConfigurationRow {
  configuration_id: string | null;
  enabled: boolean;
  voice: string;
  transfer_enabled: boolean;
  transfer_target_e164: string | null;
  provider_transfer_enabled: boolean;
  assigned_phone_number: string | null;
  realtime_model_status: string;
}

export interface VoiceRecentCallRow {
  call_id: string;
  caller_phone: string | null;
  status: string;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  handoff_requested: boolean;
}

export interface VoiceInboundBootstrapRow {
  is_duplicate: boolean;
  accepted: boolean;
  call_record_id: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  organization_id: string | null;
  location_id: string | null;
  phone_number_id: string | null;
  primary_industry_id: string | null;
  organization_name: string | null;
  business_phone: string | null;
  website_url: string | null;
  location_name: string | null;
  location_timezone: string | null;
  location_address: Json | null;
  business_hours: Json | null;
  voice: string | null;
  transfer_enabled: boolean;
  provider_transfer_enabled: boolean;
  transfer_target_e164: string | null;
}

export interface VoiceHandoffRow {
  handoff_id: string;
  created: boolean;
}

export interface VoiceKnowledgeMatchRow {
  chunk_id: string;
  document_id: string;
  title: string;
  source_url: string;
  content: string;
  similarity: number;
}

export interface EzyVetBackendAuthorizationRow {
  organization_id: string;
  location_id: string;
  location_timezone: string;
}

export interface EzyVetExecutionCredentialsRow {
  organization_id: string;
  location_id: string;
  environment: 'production' | 'trial';
  site_uid: string;
  site_timezone: string;
  client_id: string;
  client_secret: string;
  credential_version: number;
}

export interface EzyVetIntegrationLocationRow {
  integration_id: string;
  status: string;
  site_timezone: string | null;
}

export interface EzyVetIntegrationConfigurationRow {
  integration_id: string | null;
  status: string | null;
  environment: string | null;
  site_timezone: string | null;
  last_catalog_synced_at: string | null;
  last_verified_at: string | null;
  timezone_attention: boolean | null;
  appointment_type_id: string | null;
  appointment_type_name: string | null;
  appointment_type_duration_minutes: number | null;
  appointment_type_active: boolean | null;
  appointment_type_bookable: boolean | null;
  resource_id: string | null;
  resource_name: string | null;
  resource_active: boolean | null;
  resource_bookable: boolean | null;
}

export interface EzyVetBookableCatalogRow {
  appointment_type_id: string;
  appointment_type_uid: string;
  appointment_type_name: string;
  default_duration_minutes: number;
  resource_id: string;
  resource_uid: string;
  resource_name: string;
  site_timezone: string;
}

export interface VoiceSchedulingContextRow {
  organization_id: string;
  location_id: string;
  conversation_id: string;
  contact_id: string | null;
  caller_e164: string | null;
  integration_id: string;
  site_timezone: string;
}

export interface BookingCandidateRow {
  candidate_id: string;
  appointment_type_name: string;
  resource_name: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  expires_at: string;
}

export interface BookingIntentRow {
  booking_intent_id: string;
  appointment_type_name: string;
  starts_at: string;
  timezone: string;
  status: string;
}

export interface BookingClaimRow {
  state: string;
  booking_intent_id: string;
  confirmed_message_id: string | null;
}

export interface BookingExecutionContextRow {
  booking_intent_id: string;
  organization_id: string;
  location_id: string;
  conversation_id: string;
  contact_id: string | null;
  integration_id: string;
  external_contact_uid: string;
  external_subject_uid: string;
  subject_name: string;
  appointment_type_uid: string;
  appointment_type_name: string;
  default_duration_minutes: number;
  resource_uid: string;
  resource_name: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  provider_appointment_id: string | null;
  intent_status: string;
}

export interface CompletedBookingRow {
  appointment_id: string;
  is_existing: boolean;
}

export interface SchedulingAppointmentRow {
  appointment_id: string;
  title: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  provider: string | null;
  provider_status: string | null;
  created_at: string;
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
      create_knowledge_import: {
        Args: { root_url_input: string; requested_location_id?: string | null };
        Returns: KnowledgeImportRow[];
      };
      start_knowledge_import: { Args: { target_import_id: string }; Returns: undefined };
      save_knowledge_import_pages: {
        Args: {
          crawled_pages: Json;
          discovered_count: number;
          final_root_url: string;
          skipped_count: number;
          target_import_id: string;
        };
        Returns: number;
      };
      fail_knowledge_import: {
        Args: { safe_error_code: string; safe_error_message: string; target_import_id: string };
        Returns: undefined;
      };
      update_knowledge_document_draft: {
        Args: {
          draft_content: string;
          draft_title: string;
          is_included: boolean;
          target_document_id: string;
        };
        Returns: undefined;
      };
      begin_knowledge_publish: {
        Args: { target_import_id: string };
        Returns: KnowledgePublicationSnapshotRow[];
      };
      complete_knowledge_publish: {
        Args: { document_versions: Json; generated_chunks: Json; target_import_id: string };
        Returns: number;
      };
      release_knowledge_publish: {
        Args: { safe_error_code: string; safe_error_message: string; target_import_id: string };
        Returns: undefined;
      };
      recover_stale_knowledge_publish: {
        Args: { target_import_id: string };
        Returns: undefined;
      };
      get_my_knowledge_overview: { Args: EmptyRecord; Returns: KnowledgeOverviewRow[] };
      get_knowledge_import_review: {
        Args: { target_import_id: string };
        Returns: KnowledgeReviewRow[];
      };
      match_my_knowledge: {
        Args: {
          query_embedding_text: string;
          requested_location_id?: string | null;
          requested_match_count?: number;
        };
        Returns: KnowledgeMatchRow[];
      };
      create_agent_test_conversation: {
        Args: { target_location_id: string };
        Returns: AgentTestConversationRow[];
      };
      get_agent_test_conversation: {
        Args: { target_conversation_id: string };
        Returns: AgentTestMessageRow[];
      };
      begin_agent_test_turn: {
        Args: {
          customer_message: string;
          model_name: string;
          provider_name: string;
          target_conversation_id: string;
          target_idempotency_key: string;
        };
        Returns: AgentTestRunRow[];
      };
      complete_agent_test_turn: {
        Args: {
          assistant_body: string;
          handoff_requested: boolean;
          safe_failure_code?: string | null;
          source_references: Json;
          target_run_id: string;
          tool_executions: Json;
        };
        Returns: undefined;
      };
      fail_agent_test_turn: {
        Args: { safe_failure_code?: string; target_run_id: string };
        Returns: undefined;
      };
      get_agent_test_turn_result: {
        Args: { target_run_id: string };
        Returns: AgentTestTurnResultRow[];
      };
      record_agent_test_knowledge_search: {
        Args: { target_conversation_id: string; tool_call_id: string };
        Returns: undefined;
      };
      request_agent_test_handoff: {
        Args: {
          handoff_reason: string;
          handoff_urgency: 'normal' | 'urgent';
          target_conversation_id: string;
          tool_call_id: string;
        };
        Returns: AgentTestHandoffRow[];
      };
      assign_voice_phone_number: {
        Args: {
          target_organization_id: string;
          target_location_id: string;
          target_phone_number: string;
          target_label?: string | null;
        };
        Returns: { phone_number_id: string; phone_number: string }[];
      };
      upsert_my_voice_configuration: {
        Args: {
          target_location_id: string;
          target_enabled: boolean;
          target_voice: string;
          target_transfer_enabled: boolean;
          target_transfer_target_e164: string;
        };
        Returns: Omit<VoiceConfigurationRow, 'assigned_phone_number' | 'realtime_model_status'>[];
      };
      set_voice_provider_transfer_capability: {
        Args: {
          target_enabled: boolean;
          target_location_id: string;
          target_organization_id: string;
        };
        Returns: undefined;
      };
      get_my_voice_configuration: {
        Args: { target_location_id: string };
        Returns: VoiceConfigurationRow[];
      };
      get_my_recent_voice_calls: {
        Args: { target_location_id: string };
        Returns: VoiceRecentCallRow[];
      };
      bootstrap_inbound_voice_call: {
        Args: {
          target_event_id: string;
          target_event_type: string;
          target_external_call_id: string;
          target_sip_call_id: string;
          target_dialed_e164: string | null;
          target_caller_e164?: string | null;
        };
        Returns: VoiceInboundBootstrapRow[];
      };
      mark_inbound_voice_call_active: {
        Args: { target_call_id: string };
        Returns: undefined;
      };
      finalize_inbound_voice_call: {
        Args: { target_call_id: string; target_status: string; target_end_reason: string };
        Returns: undefined;
      };
      record_inbound_voice_transcript: {
        Args: {
          target_call_id: string;
          target_external_item_id: string;
          target_direction: string;
          target_body: string;
        };
        Returns: boolean;
      };
      request_inbound_voice_handoff: {
        Args: {
          target_call_id: string;
          target_tool_call_id: string;
          target_reason: string;
          target_urgency?: string;
        };
        Returns: VoiceHandoffRow[];
      };
      record_inbound_voice_tool_execution: {
        Args: {
          target_call_id: string;
          target_tool_call_id: string;
          target_tool_name: string;
          target_status: string;
        };
        Returns: undefined;
      };
      match_inbound_voice_knowledge: {
        Args: {
          target_organization_id: string;
          target_location_id: string;
          query_embedding_text: string;
          requested_match_count?: number;
        };
        Returns: VoiceKnowledgeMatchRow[];
      };
      get_ezyvet_backend_authorization: {
        Args: { target_user_id: string; target_location_id: string };
        Returns: EzyVetBackendAuthorizationRow[];
      };
      store_ezyvet_connection: {
        Args: {
          target_organization_id: string;
          target_location_id: string;
          target_client_id: string;
          target_client_secret: string;
          target_environment: 'production' | 'trial';
          target_site_uid: string;
          target_provider_site_id: string;
          target_provider_timezone: string;
        };
        Returns: { integration_id: string }[];
      };
      get_ezyvet_execution_credentials: {
        Args: { target_integration_id: string };
        Returns: EzyVetExecutionCredentialsRow[];
      };
      get_ezyvet_integration_for_location: {
        Args: { target_organization_id: string; target_location_id: string };
        Returns: EzyVetIntegrationLocationRow[];
      };
      save_ezyvet_catalog: {
        Args: {
          target_integration_id: string;
          appointment_types: Json;
          resources: Json;
          target_site_timezone: string;
        };
        Returns: undefined;
      };
      get_my_ezyvet_integration_configuration: {
        Args: { target_location_id: string };
        Returns: EzyVetIntegrationConfigurationRow[];
      };
      update_my_ezyvet_booking_policy: {
        Args: {
          target_location_id: string;
          selected_appointment_type_ids: string[];
          selected_resource_ids: string[];
        };
        Returns: undefined;
      };
      disable_ezyvet_integration: {
        Args: { target_organization_id: string; target_location_id: string };
        Returns: undefined;
      };
      get_voice_ezyvet_scheduling_context: {
        Args: { target_call_id: string };
        Returns: VoiceSchedulingContextRow[];
      };
      get_ezyvet_bookable_catalog: {
        Args: { target_integration_id: string };
        Returns: EzyVetBookableCatalogRow[];
      };
      create_voice_booking_candidates: {
        Args: { target_call_id: string; available_slots: Json };
        Returns: BookingCandidateRow[];
      };
      prepare_voice_booking_intent: {
        Args: {
          target_call_id: string;
          target_candidate_id: string;
          resolved_contact_uid: string;
          resolved_subject_uid: string;
          resolved_subject_name: string;
        };
        Returns: BookingIntentRow[];
      };
      claim_voice_booking_intent: {
        Args: {
          target_call_id: string;
          target_booking_intent_id: string;
          target_tool_call_id: string;
        };
        Returns: BookingClaimRow[];
      };
      get_voice_booking_execution_context: {
        Args: { target_booking_intent_id: string };
        Returns: BookingExecutionContextRow[];
      };
      complete_voice_booking_intent: {
        Args: {
          target_booking_intent_id: string;
          target_external_appointment_id: string;
          target_provider_status: 'confirmed' | 'unconfirmed';
        };
        Returns: CompletedBookingRow[];
      };
      record_voice_booking_provider_success: {
        Args: {
          target_booking_intent_id: string;
          target_external_appointment_id: string;
          target_provider_status: 'confirmed' | 'unconfirmed';
        };
        Returns: undefined;
      };
      fail_voice_booking_intent: {
        Args: {
          target_booking_intent_id: string;
          target_status: string;
          target_error_category: string;
        };
        Returns: undefined;
      };
      get_my_scheduling_appointments: {
        Args: { target_location_id: string };
        Returns: SchedulingAppointmentRow[];
      };
    };
    Enums: EmptyRecord;
    CompositeTypes: EmptyRecord;
  };
}
