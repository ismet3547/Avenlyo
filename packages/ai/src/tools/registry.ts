import type { IndustryPack } from '@avenlyo/industries';
import type { ZodType } from 'zod';

import { mayExposeHandoffTool } from '../policy/action-policy';
import type { AgentFunctionTool } from '../agent/types';

import {
  availableAppointmentsSchema,
  bookAppointmentFunction,
  bookAppointmentSchema,
  getAvailableAppointmentsFunction,
  prepareAppointmentBookingFunction,
  prepareAppointmentBookingSchema,
  requestHumanHelpFunction,
  requestHumanHelpSchema,
  searchBusinessKnowledgeFunction,
  searchBusinessKnowledgeSchema,
} from './schemas';
import type { ToolDefinition } from './types';

const searchTool: ToolDefinition<typeof searchBusinessKnowledgeSchema> = {
  function: searchBusinessKnowledgeFunction,
  name: 'search_business_knowledge',
  schema: searchBusinessKnowledgeSchema,
};

const handoffTool: ToolDefinition<typeof requestHumanHelpSchema> = {
  function: requestHumanHelpFunction,
  name: 'request_human_help',
  schema: requestHumanHelpSchema,
};
const availabilityTool: ToolDefinition<typeof availableAppointmentsSchema> = {
  function: getAvailableAppointmentsFunction,
  name: 'get_available_appointments',
  schema: availableAppointmentsSchema,
};
const prepareTool: ToolDefinition<typeof prepareAppointmentBookingSchema> = {
  function: prepareAppointmentBookingFunction,
  name: 'prepare_appointment_booking',
  schema: prepareAppointmentBookingSchema,
};
const bookTool: ToolDefinition<typeof bookAppointmentSchema> = {
  function: bookAppointmentFunction,
  name: 'book_appointment',
  schema: bookAppointmentSchema,
};

/** Source-controlled registry: no customer, website, or model input can add a tool. */
export function activeToolDefinitions(
  industry: IndustryPack,
  schedulingEnabled = false,
): readonly ToolDefinition<ZodType>[] {
  const base = mayExposeHandoffTool(industry) ? [searchTool, handoffTool] : [searchTool];
  return schedulingEnabled ? [...base, availabilityTool, prepareTool, bookTool] : base;
}

export function activeToolsForIndustry(industry: IndustryPack): readonly AgentFunctionTool[] {
  return activeToolDefinitions(industry).map((tool) => tool.function);
}
