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

/** Roles an invitation may grant. Owner is deliberately absent: ownership transfer is not an
 * invitation side effect. */
export type InvitationRole = 'admin' | 'member';

/** Derived from timestamps rather than a stored status column, so the two cannot disagree. */
export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface OrganizationInvitationRow {
  invitation_id: string | null;
  /** Returned exactly once, at creation. Never present in any read model. */
  invitation_token: string | null;
  email_normalized: string;
  role: InvitationRole;
  expires_at: string | null;
  outcome: 'created' | 'already_member';
}

export interface InvitationAcceptanceRow {
  organization_id: string | null;
  organization_name: string | null;
  membership_role: InvitationRole | null;
  outcome:
    | 'accepted'
    | 'already_accepted'
    | 'expired'
    | 'invalid'
    | 'invalid_scope'
    | 'revoked'
    | 'wrong_account';
}

export interface TeamMutationRow {
  outcome: string;
}

/** One row per team member or invitation. The discriminator keeps a single bounded read. */
export interface OrganizationTeamRow {
  record_kind: 'invitation' | 'member';
  record_id: string;
  member_user_id: string | null;
  display_name: string | null;
  email: string | null;
  role: MemberRole;
  is_active: boolean;
  joined_at: string;
  expires_at: string | null;
  invitation_state: InvitationState | null;
  location_ids: string[];
  location_names: string[];
  /** Live human work this member is holding. A count only, never conversation content. */
  active_work_count: number;
}

export interface WorkspaceContextRow {
  organization_id: string;
  organization_name: string;
  membership_id: string;
  membership_role: MemberRole;
  location_id: string | null;
  location_name: string | null;
  onboarding_status: OnboardingStatus | null;
  onboarding_step: OnboardingStep | null;
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

export interface GoogleBackendAuthorizationRow {
  organization_id: string;
  location_id: string;
  location_timezone: string;
}

export interface GoogleCalendarExecutionCredentialsRow {
  organization_id: string;
  location_id: string;
  refresh_token: string;
  credential_version: number;
}

export interface GoogleCalendarIntegrationLocationRow {
  integration_id: string;
  status: string;
  last_verified_at: string | null;
}

export interface GoogleCalendarConfigurationRow {
  integration_id: string | null;
  status: string | null;
  last_verified_at: string | null;
  is_active: boolean | null;
  minimum_lead_minutes: number | null;
  appointment_type_id: string | null;
  appointment_type_name: string | null;
  appointment_type_duration_minutes: number | null;
  appointment_type_bookable: boolean | null;
  resource_id: string | null;
  resource_name: string | null;
  resource_access_role: string | null;
  resource_bookable: boolean | null;
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

export interface GenericVoiceSchedulingContextRow {
  organization_id: string;
  location_id: string;
  conversation_id: string;
  contact_id: string | null;
  caller_e164: string | null;
  contact_display_name: string | null;
  integration_id: string;
  provider: 'ezyvet' | 'google_calendar';
  timezone: string;
  business_hours: Json;
  minimum_lead_minutes: number;
}

export interface SchedulingBookableCatalogRow {
  appointment_type_id: string;
  appointment_type_uid: string;
  appointment_type_name: string;
  default_duration_minutes: number;
  resource_id: string;
  resource_uid: string;
  resource_name: string;
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

export interface GenericBookingExecutionContextRow {
  booking_intent_id: string;
  organization_id: string;
  location_id: string;
  conversation_id: string;
  contact_id: string | null;
  integration_id: string;
  provider: 'ezyvet' | 'google_calendar';
  external_contact_uid: string | null;
  external_subject_uid: string | null;
  subject_name: string | null;
  trusted_phone_e164: string | null;
  customer_display_name: string | null;
  appointment_type_uid: string;
  appointment_type_name: string;
  default_duration_minutes: number;
  resource_uid: string;
  resource_name: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  business_hours: Json;
  minimum_lead_minutes: number;
  provider_appointment_id: string | null;
  provider_booking_status: 'confirmed' | 'unconfirmed' | null;
  intent_status: string;
  current_write_eligible: boolean;
}

export interface ConversationSchedulingContextRow {
  organization_id: string;
  location_id: string;
  conversation_id: string;
  contact_id: string | null;
  trusted_transport_phone_e164: string | null;
  contact_display_name: string | null;
  integration_id: string;
  provider: 'ezyvet' | 'google_calendar';
  timezone: string;
  business_hours: Json;
  minimum_lead_minutes: number;
  channel_type: 'sms' | 'web' | 'phone';
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

export interface MessagingInboundBootstrapRow {
  accepted: boolean;
  is_duplicate: boolean;
  message_id: string | null;
  conversation_id: string | null;
  organization_id: string | null;
  location_id: string | null;
  command: string | null;
}

export interface WebChatSessionRow {
  session_id: string;
  conversation_id: string;
  welcome_message: string | null;
}

export interface WebChatMessageRow {
  message_id: string;
  conversation_id: string;
  is_duplicate: boolean;
}

export interface PublicWebChatMessageRow {
  message_id: string;
  direction: string;
  author_type: string;
  body: string | null;
  created_at: string;
}

export interface InboxConversationRow {
  conversation_id: string;
  location_id: string | null;
  channel_type: string;
  contact_name: string | null;
  contact_phone: string | null;
  latest_body: string | null;
  latest_at: string;
  ai_mode: 'ai' | 'human';
  handoff_open: boolean;
}

export interface InboxMessageRow {
  message_id: string;
  direction: string;
  author_type: string;
  body: string | null;
  source_channel: string;
  delivery_status: string | null;
  created_at: string;
}

export interface HandoffQueueRow {
  conversation_id: string;
  location_id: string | null;
  channel_type: string;
  contact_name: string | null;
  contact_phone: string | null;
  ai_mode: 'ai' | 'human';
  conversation_assigned_to_me: boolean;
  conversation_is_assigned: boolean;
  conversation_assigned_name: string | null;
  handoff_id: string | null;
  handoff_is_active: boolean;
  handoff_status: 'open' | 'acknowledged' | 'resolved' | null;
  handoff_urgency: 'normal' | 'urgent' | null;
  handoff_reason: string | null;
  handoff_assigned_to_me: boolean;
  handoff_is_assigned: boolean;
  handoff_assigned_name: string | null;
  handoff_source: 'voice' | 'message' | null;
  handoff_call_status: string | null;
  handoff_created_at: string | null;
  handoff_first_acknowledged_at: string | null;
  handoff_resolved_at: string | null;
  customer_waiting: boolean;
  waiting_since: string | null;
  latest_body: string | null;
  latest_at: string;
  lead_status: string | null;
  lead_urgency: string | null;
  queue_priority: number;
}

export interface HandoffQueueSummaryRow {
  needs_attention: number;
  urgent: number;
  assigned_to_me: number;
}

export interface HandoffHistoryRow {
  handoff_id: string;
  handoff_status: 'open' | 'acknowledged' | 'resolved';
  handoff_urgency: 'normal' | 'urgent';
  handoff_reason: string;
  handoff_source: 'voice' | 'message';
  requested_at: string;
  first_acknowledged_at: string | null;
  resolved_at: string | null;
  assigned_display_name: string | null;
  resolved_by_display_name: string | null;
}

export interface HandoffClaimResultRow {
  outcome: 'claimed' | 'already_claimed' | 'already_resolved';
  handoff_id: string | null;
  conversation_id: string | null;
  handoff_status: string | null;
  urgency: string | null;
  assigned_to_me: boolean;
  assigned_display_name: string | null;
  first_acknowledged_at: string | null;
}

export interface HandoffReleaseResultRow {
  outcome: 'released' | 'not_active';
  handoff_id: string | null;
  conversation_id: string | null;
  handoff_status: string | null;
}

export interface HandoffResolveResultRow {
  outcome: 'resolved' | 'already_resolved';
  handoff_id: string | null;
  conversation_id: string | null;
  handoff_status: string | null;
  ai_mode: string | null;
}

export interface ConversationTakeoverResultRow {
  outcome: 'taken_over' | 'already_claimed' | 'already_resolved' | 'owned_by_other';
  conversation_id: string | null;
  handoff_id: string | null;
  assigned_display_name: string | null;
}

export interface ConversationResumeResultRow {
  outcome: 'resumed' | 'resolve_handoff_first' | 'owned_by_other';
  conversation_id: string | null;
  ai_mode: string | null;
  assigned_display_name: string | null;
}

export interface HumanReplyResultRow {
  outcome: 'sent' | 'owned_by_other';
  message_id: string | null;
  source_channel: string;
  assigned_display_name: string | null;
}

export interface PlatformReadinessProbeRow {
  checked_at: string;
  schema_version: number;
}

export interface PlatformRuntimeStatusRow {
  instance_id: string;
  service: string;
  release: string;
  started_at: string;
  last_heartbeat_at: string;
  stopped_at: string | null;
  component: string | null;
  component_state: string | null;
  last_tick_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number | null;
  last_error_code: string | null;
}

export interface PlatformOperationalMetricRow {
  metric_group: string;
  metric: string;
  value: number;
  oldest_at: string | null;
  detail: string | null;
}

export interface MessageProcessingJobRow {
  job_id: string;
  job_kind: 'inbound_ai' | 'outbound_delivery';
  message_id: string;
  conversation_id: string;
  organization_id: string;
  location_id: string | null;
  attempts: number;
}

export interface MessageRuntimeContextRow {
  message_id: string;
  conversation_id: string;
  organization_id: string;
  location_id: string | null;
  channel_type: 'sms' | 'web' | 'phone' | 'email' | 'whatsapp';
  ai_mode: 'ai' | 'human';
  body: string | null;
  contact_id: string | null;
  contact_phone: string | null;
  transport_phone_number_id: string | null;
  inbound_message_id: string;
}

export interface AssistantMessageResultRow {
  message_id: string | null;
  created: boolean;
}

export interface SmsDeliveryExecutionRow {
  message_id: string;
  delivery_id: string;
  to_e164: string;
  from_e164: string;
  body: string;
  status: string;
}

export interface AppointmentReminderSettingsRow {
  sms_enabled: boolean;
  reminder_24h_enabled: boolean;
  reminder_2h_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  sms_sender_available: boolean;
  timezone: string;
}

export interface AppointmentReminderClaimRow {
  reminder_id: string;
}

export interface AppointmentReminderReconciliationRow {
  appointment_id: string;
}

export interface AppointmentReminderRow {
  appointment_id: string;
  reminder_type: 'appointment_24h' | 'appointment_2h';
  scheduled_for: string;
  status: 'scheduled' | 'processing' | 'sent' | 'skipped' | 'failed';
  last_error_code: string | null;
  message_id: string | null;
}

export interface AppointmentReminderExecutionRow {
  reminder_id: string;
  appointment_id: string;
  organization_id: string;
  location_id: string;
  provider: 'ezyvet' | 'google_calendar' | null;
  integration_id: string | null;
  integration_status: string | null;
  external_appointment_id: string | null;
  booking_intent_id: string | null;
  starts_at: string;
  ends_at: string | null;
  timezone: string;
  provider_resource_key: string | null;
  appointment_type_key: string | null;
  external_contact_uid: string | null;
  external_subject_uid: string | null;
  trusted_sms_recipient_e164: string | null;
}

export interface MessageAgentContextRow {
  message_id: string;
  conversation_id: string;
  organization_id: string;
  location_id: string;
  industry_id: string;
  organization_name: string;
  location_name: string;
  location_timezone: string;
  location_address: Json;
  business_hours: Json;
  business_phone: string | null;
  website_url: string | null;
  channel_type: 'sms' | 'web' | 'phone';
  history: Json;
}

export interface WebChatWidgetConfigurationRow {
  widget_id: string;
  public_key: string;
  enabled: boolean;
  allowed_origins: Json;
  welcome_message: string | null;
}

type EmptyRecord = Record<never, never>;

export interface Database {
  public: {
    Tables: EmptyRecord;
    Views: EmptyRecord;
    Functions: {
      accept_my_organization_invitation: {
        Args: { target_token: string };
        Returns: InvitationAcceptanceRow[];
      };
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
      create_my_organization_invitation: {
        Args: {
          target_organization_id: string;
          target_email: string;
          target_role: InvitationRole;
          target_location_ids?: string[];
        };
        Returns: OrganizationInvitationRow[];
      };
      get_my_organization_team: {
        Args: { target_organization_id: string };
        Returns: OrganizationTeamRow[];
      };
      get_my_workspace_contexts: {
        Args: EmptyRecord;
        Returns: WorkspaceContextRow[];
      };
      get_my_workspace_context: {
        Args: { target_organization_id: string; target_location_id: string | null };
        Returns: TenantContextRow[];
      };
      revoke_my_organization_invitation: {
        Args: { target_invitation_id: string };
        Returns: TeamMutationRow[];
      };
      revoke_my_organization_member: {
        Args: { target_membership_id: string };
        Returns: TeamMutationRow[];
      };
      update_my_organization_member_access: {
        Args: {
          target_membership_id: string;
          target_role: InvitationRole;
          target_location_ids?: string[];
        };
        Returns: TeamMutationRow[];
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
      get_voice_transcript_message_id: {
        Args: { target_call_id: string; target_external_item_id: string };
        Returns: string | null;
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
      get_google_backend_authorization: {
        Args: { target_user_id: string; target_location_id: string };
        Returns: GoogleBackendAuthorizationRow[];
      };
      create_google_oauth_state: {
        Args: { target_user_id: string; target_location_id: string; target_state_hash: string };
        Returns: GoogleBackendAuthorizationRow[];
      };
      consume_google_oauth_state: {
        Args: { target_state_hash: string };
        Returns: { user_id: string; organization_id: string; location_id: string }[];
      };
      store_google_calendar_connection: {
        Args: {
          target_organization_id: string;
          target_location_id: string;
          target_refresh_token: string;
        };
        Returns: { integration_id: string }[];
      };
      get_google_calendar_execution_credentials: {
        Args: { target_integration_id: string };
        Returns: GoogleCalendarExecutionCredentialsRow[];
      };
      get_google_calendar_integration_for_location: {
        Args: { target_organization_id: string; target_location_id: string };
        Returns: GoogleCalendarIntegrationLocationRow[];
      };
      save_google_calendar_resources: {
        Args: { target_integration_id: string; calendars: Json };
        Returns: undefined;
      };
      get_my_google_scheduling_configuration: {
        Args: { target_location_id: string };
        Returns: GoogleCalendarConfigurationRow[];
      };
      create_my_google_appointment_type: {
        Args: { target_location_id: string; target_name: string; target_duration_minutes: number };
        Returns: { appointment_type_id: string }[];
      };
      update_my_google_booking_policy: {
        Args: {
          target_location_id: string;
          selected_appointment_type_ids: string[];
          selected_resource_ids: string[];
          mappings: Json;
        };
        Returns: undefined;
      };
      set_my_active_scheduling_integration: {
        Args: {
          target_location_id: string;
          target_integration_id: string;
          target_minimum_lead_minutes?: number;
        };
        Returns: undefined;
      };
      disable_google_calendar_integration: {
        Args: { target_organization_id: string; target_location_id: string };
        Returns: undefined;
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
      get_voice_scheduling_context: {
        Args: { target_call_id: string };
        Returns: GenericVoiceSchedulingContextRow[];
      };
      get_scheduling_bookable_catalog: {
        Args: { target_integration_id: string };
        Returns: SchedulingBookableCatalogRow[];
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
      prepare_voice_scheduling_booking_intent: {
        Args: {
          target_call_id: string;
          target_candidate_id: string;
          resolved_contact_uid: string | null;
          resolved_subject_uid: string | null;
          resolved_subject_name: string | null;
          trusted_contact_id: string | null;
        };
        Returns: BookingIntentRow[];
      };
      claim_voice_scheduling_booking_intent: {
        Args: {
          target_call_id: string;
          target_booking_intent_id: string;
          target_tool_call_id: string;
          target_inbound_message_id?: string | null;
        };
        Returns: BookingClaimRow[];
      };
      claim_booking_slot_lease: {
        Args: { target_booking_intent_id: string };
        Returns: { lease_id: string }[];
      };
      release_booking_slot_lease: {
        Args: { target_booking_intent_id: string };
        Returns: undefined;
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
        Returns: GenericBookingExecutionContextRow[];
      };
      complete_voice_booking_intent: {
        Args: { target_booking_intent_id: string };
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
      bootstrap_inbound_sms: {
        Args: {
          target_message_sid: string;
          target_from_e164: string;
          target_to_e164: string;
          target_body: string;
          target_media?: Json;
          target_provider_metadata?: Json;
        };
        Returns: MessagingInboundBootstrapRow[];
      };
      create_web_chat_session: {
        Args: {
          target_widget_public_key: string;
          target_origin: string;
          target_token_hash: string;
          target_rate_scope: string;
        };
        Returns: WebChatSessionRow[];
      };
      append_web_chat_message: {
        Args: {
          target_token_hash: string;
          target_client_message_id: string;
          target_body: string;
          target_rate_scope: string;
        };
        Returns: WebChatMessageRow[];
      };
      get_web_chat_messages: {
        Args: { target_token_hash: string; target_after?: string | null };
        Returns: PublicWebChatMessageRow[];
      };
      get_my_inbox_conversations: {
        Args: { target_location_id?: string | null };
        Returns: InboxConversationRow[];
      };
      get_my_inbox_messages: {
        Args: { target_conversation_id: string };
        Returns: InboxMessageRow[];
      };
      take_over_my_conversation: {
        Args: { target_conversation_id: string };
        Returns: ConversationTakeoverResultRow[];
      };
      resume_my_conversation_ai: {
        Args: { target_conversation_id: string };
        Returns: ConversationResumeResultRow[];
      };
      create_my_human_reply: {
        Args: { target_conversation_id: string; target_body: string };
        Returns: HumanReplyResultRow[];
      };
      claim_my_handoff: { Args: { target_handoff_id: string }; Returns: HandoffClaimResultRow[] };
      release_my_handoff: {
        Args: { target_handoff_id: string };
        Returns: HandoffReleaseResultRow[];
      };
      resolve_my_handoff: {
        Args: { target_handoff_id: string };
        Returns: HandoffResolveResultRow[];
      };
      get_my_handoff_queue: {
        Args: {
          target_location_id?: string | null;
          target_filter?: string | null;
          target_limit?: number | null;
        };
        Returns: HandoffQueueRow[];
      };
      get_my_handoff_queue_summary: {
        Args: { target_location_id?: string | null };
        Returns: HandoffQueueSummaryRow[];
      };
      get_my_conversation_handoff_history: {
        Args: { target_conversation_id: string; target_limit?: number | null };
        Returns: HandoffHistoryRow[];
      };
      get_my_web_chat_widget: {
        Args: { target_location_id: string };
        Returns: WebChatWidgetConfigurationRow[];
      };
      upsert_my_web_chat_widget: {
        Args: {
          target_location_id: string;
          target_enabled: boolean;
          target_allowed_origins: Json;
          target_welcome_message?: string | null;
        };
        Returns: WebChatWidgetConfigurationRow[];
      };
      platform_readiness_probe: {
        Args: Record<string, never>;
        Returns: PlatformReadinessProbeRow[];
      };
      get_platform_runtime_status: {
        Args: Record<string, never>;
        Returns: PlatformRuntimeStatusRow[];
      };
      get_platform_operational_snapshot: {
        Args: Record<string, never>;
        Returns: PlatformOperationalMetricRow[];
      };
      register_runtime_instance: {
        Args: { target_instance_id: string; target_service: string; target_release: string };
        Returns: undefined;
      };
      heartbeat_runtime_instance: { Args: { target_instance_id: string }; Returns: undefined };
      heartbeat_runtime_component: {
        Args: {
          target_instance_id: string;
          target_component: string;
          target_state: string;
          target_succeeded: boolean | null;
          target_error_code?: string | null;
        };
        Returns: undefined;
      };
      stop_runtime_instance: { Args: { target_instance_id: string }; Returns: undefined };
      claim_message_processing_jobs: {
        Args: { target_worker_id: string; target_limit?: number };
        Returns: MessageProcessingJobRow[];
      };
      complete_message_processing_job: { Args: { target_job_id: string }; Returns: undefined };
      retry_message_processing_job: {
        Args: { target_job_id: string; target_error_code: string };
        Returns: undefined;
      };
      get_message_runtime_context: {
        Args: { target_message_id: string };
        Returns: MessageRuntimeContextRow[];
      };
      persist_ai_message_reply: {
        Args: {
          target_inbound_message_id: string;
          target_body: string;
          target_handoff_requested?: boolean;
        };
        Returns: AssistantMessageResultRow[];
      };
      get_message_agent_context: {
        Args: { target_message_id: string };
        Returns: MessageAgentContextRow[];
      };
      has_persisted_ai_reply: {
        Args: { target_inbound_message_id: string };
        Returns: boolean;
      };
      request_message_handoff: {
        Args: {
          target_inbound_message_id: string;
          target_tool_call_id: string;
          target_reason: string;
          target_urgency?: string;
        };
        Returns: { handoff_id: string; created: boolean }[];
      };
      get_sms_delivery_execution_context: {
        Args: { target_message_id: string };
        Returns: SmsDeliveryExecutionRow[];
      };
      claim_sms_delivery_submission: {
        Args: { target_message_id: string };
        Returns: SmsDeliveryExecutionRow[];
      };
      set_sms_phone_number_enabled_for_user: {
        Args: { target_user_id: string; target_phone_number_id: string; target_enabled: boolean };
        Returns: undefined;
      };
      get_sms_phone_number_for_user: {
        Args: { target_user_id: string; target_phone_number_id: string };
        Returns: string;
      };
      mark_sms_delivery_sending: { Args: { target_message_id: string }; Returns: undefined };
      record_sms_delivery_submission: {
        Args: {
          target_message_id: string;
          target_provider_message_id: string;
          target_provider_status: string;
        };
        Returns: undefined;
      };
      mark_sms_delivery_unknown: {
        Args: { target_message_id: string; target_error_code: string };
        Returns: undefined;
      };
      record_twilio_message_status: {
        Args: {
          target_provider_message_id: string;
          target_status: string;
          target_error_code?: string | null;
        };
        Returns: undefined;
      };
      claim_conversation_scheduling_booking_intent: {
        Args: {
          target_conversation_id: string;
          target_inbound_message_id: string;
          target_booking_intent_id: string;
          target_tool_call_id: string;
        };
        Returns: BookingClaimRow[];
      };
      get_conversation_scheduling_context: {
        Args: { target_conversation_id: string; target_inbound_message_id: string | null };
        Returns: ConversationSchedulingContextRow[];
      };
      create_conversation_booking_candidates: {
        Args: { target_conversation_id: string; available_slots: Json };
        Returns: BookingCandidateRow[];
      };
      prepare_conversation_scheduling_booking_intent: {
        Args: {
          target_conversation_id: string;
          target_candidate_id: string;
          resolved_contact_uid: string | null;
          resolved_subject_uid: string | null;
          resolved_subject_name: string | null;
          trusted_contact_id: string | null;
          target_inbound_message_id: string | null;
        };
        Returns: BookingIntentRow[];
      };
      get_scheduling_booking_execution_context: {
        Args: { target_booking_intent_id: string };
        Returns: GenericBookingExecutionContextRow[];
      };
      record_scheduling_booking_provider_success: {
        Args: {
          target_booking_intent_id: string;
          target_external_appointment_id: string;
          target_provider_status: 'confirmed' | 'unconfirmed';
        };
        Returns: undefined;
      };
      complete_scheduling_booking_intent: {
        Args: { target_booking_intent_id: string };
        Returns: CompletedBookingRow[];
      };
      get_my_appointment_reminder_settings: {
        Args: { target_location_id: string };
        Returns: AppointmentReminderSettingsRow[];
      };
      get_my_appointment_reminders: {
        Args: { target_location_id: string };
        Returns: AppointmentReminderRow[];
      };
      upsert_my_appointment_reminder_settings: {
        Args: {
          target_location_id: string;
          target_sms_enabled: boolean;
          target_24h_enabled: boolean;
          target_2h_enabled: boolean;
          target_quiet_hours_start?: string;
          target_quiet_hours_end?: string;
        };
        Returns: undefined;
      };
      refresh_appointment_reminders: {
        Args: { target_appointment_id: string };
        Returns: undefined;
      };
      claim_due_appointment_reminders: {
        Args: { target_worker_id: string; target_limit?: number };
        Returns: AppointmentReminderClaimRow[];
      };
      reconcile_appointment_reminder_schedules: {
        Args: { target_limit?: number };
        Returns: AppointmentReminderReconciliationRow[];
      };
      get_appointment_reminder_execution_context: {
        Args: { target_reminder_id: string };
        Returns: AppointmentReminderExecutionRow[];
      };
      record_appointment_reminder_revalidation: {
        Args: {
          target_reminder_id: string;
          target_outcome:
            'confirmed' | 'not_required' | 'provider_not_confirmed' | 'provider_unavailable';
        };
        Returns: undefined;
      };
      create_appointment_reminder_message: {
        Args: { target_reminder_id: string };
        Returns: { message_id: string }[];
      };
      fail_scheduling_booking_intent: {
        Args: {
          target_booking_intent_id: string;
          target_status: string;
          target_error_category: string;
        };
        Returns: undefined;
      };
    };
    Enums: EmptyRecord;
    CompositeTypes: EmptyRecord;
  };
}
