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
    };
    Enums: EmptyRecord;
    CompositeTypes: EmptyRecord;
  };
}
