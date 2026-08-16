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
    };
    Enums: EmptyRecord;
    CompositeTypes: EmptyRecord;
  };
}
