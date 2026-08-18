import type { IndustryPack } from '@avenlyo/industries';
import type { ZodType } from 'zod';

import { mayExposeHandoffTool } from '../policy/action-policy';
import type { AgentFunctionTool } from '../agent/types';

import {
  availableAppointmentsSchema,
  appointmentChangeExecutionSchema,
  bookAppointmentFunction,
  bookAppointmentSchema,
  cancelAppointmentFunction,
  captureLeadFunction,
  captureLeadSchema,
  getUpcomingAppointmentsFunction,
  getRescheduleOptionsFunction,
  prepareAppointmentCancellationFunction,
  prepareAppointmentCancellationSchema,
  prepareAppointmentRescheduleFunction,
  prepareAppointmentRescheduleSchema,
  rescheduleAppointmentFunction,
  rescheduleOptionsSchema,
  upcomingAppointmentsSchema,
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
const captureLeadTool: ToolDefinition<typeof captureLeadSchema> = {
  function: captureLeadFunction,
  name: 'capture_lead',
  schema: captureLeadSchema,
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
const upcomingTool: ToolDefinition<typeof upcomingAppointmentsSchema> = {
  function: getUpcomingAppointmentsFunction,
  name: 'get_upcoming_appointments',
  schema: upcomingAppointmentsSchema,
};
const rescheduleOptionsTool: ToolDefinition<typeof rescheduleOptionsSchema> = {
  function: getRescheduleOptionsFunction,
  name: 'get_reschedule_options',
  schema: rescheduleOptionsSchema,
};
const prepareRescheduleTool: ToolDefinition<typeof prepareAppointmentRescheduleSchema> = {
  function: prepareAppointmentRescheduleFunction,
  name: 'prepare_appointment_reschedule',
  schema: prepareAppointmentRescheduleSchema,
};
const prepareCancellationTool: ToolDefinition<typeof prepareAppointmentCancellationSchema> = {
  function: prepareAppointmentCancellationFunction,
  name: 'prepare_appointment_cancellation',
  schema: prepareAppointmentCancellationSchema,
};
const rescheduleTool: ToolDefinition<typeof appointmentChangeExecutionSchema> = {
  function: rescheduleAppointmentFunction,
  name: 'reschedule_appointment',
  schema: appointmentChangeExecutionSchema,
};
const cancellationTool: ToolDefinition<typeof appointmentChangeExecutionSchema> = {
  function: cancelAppointmentFunction,
  name: 'cancel_appointment',
  schema: appointmentChangeExecutionSchema,
};

/** Source-controlled registry: no customer, website, or model input can add a tool. */
export function activeToolDefinitions(
  industry: IndustryPack,
  schedulingEnabled = false,
  lifecycleEnabled = false,
  leadCaptureEnabled = false,
): readonly ToolDefinition<ZodType>[] {
  const base = mayExposeHandoffTool(industry) ? [searchTool, handoffTool] : [searchTool];
  const withLead =
    leadCaptureEnabled && industry.allowedActions.includes('capture_lead')
      ? [...base, captureLeadTool]
      : base;
  const scheduling = schedulingEnabled
    ? [...withLead, availabilityTool, prepareTool, bookTool]
    : withLead;
  return lifecycleEnabled
    ? [
        ...scheduling,
        upcomingTool,
        rescheduleOptionsTool,
        prepareRescheduleTool,
        prepareCancellationTool,
        rescheduleTool,
        cancellationTool,
      ]
    : scheduling;
}

export function activeToolsForIndustry(industry: IndustryPack): readonly AgentFunctionTool[] {
  return activeToolDefinitions(industry).map((tool) => tool.function);
}
