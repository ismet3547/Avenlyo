import type { IndustryPack } from '@avenlyo/industries';
import type { ZodType } from 'zod';

import { mayExposeHandoffTool } from '../policy/action-policy';
import type { AgentFunctionTool } from '../agent/types';

import {
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

/** Source-controlled registry: no customer, website, or model input can add a tool. */
export function activeToolDefinitions(industry: IndustryPack): readonly ToolDefinition<ZodType>[] {
  return mayExposeHandoffTool(industry) ? [searchTool, handoffTool] : [searchTool];
}

export function activeToolsForIndustry(industry: IndustryPack): readonly AgentFunctionTool[] {
  return activeToolDefinitions(industry).map((tool) => tool.function);
}
