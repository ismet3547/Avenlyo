import type { IndustryPack } from '@avenlyo/industries';

export type AgentActionRisk = 'forbidden' | 'safe' | 'unavailable';

export const actionRiskByName: Readonly<Record<string, AgentActionRisk>> = {
  book_appointment: 'unavailable',
  cancel_appointment: 'unavailable',
  create_customer: 'unavailable',
  create_lead: 'unavailable',
  find_customer: 'unavailable',
  get_available_appointments: 'unavailable',
  medical_action: 'forbidden',
  request_human_help: 'safe',
  search_business_knowledge: 'safe',
  send_sms: 'unavailable',
  transfer_call: 'unavailable',
};

/** Conceptual pack permissions and concrete runtime availability are intentionally separate. */
export function mayExposeHandoffTool(industry: IndustryPack): boolean {
  return industry.allowedActions.includes('handoff_to_human');
}
