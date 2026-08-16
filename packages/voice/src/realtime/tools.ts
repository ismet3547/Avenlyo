import {
  MIN_AGENT_KNOWLEDGE_SIMILARITY,
  requestHumanHelpFunction,
  requestHumanHelpSchema,
  searchBusinessKnowledgeFunction,
  searchBusinessKnowledgeSchema,
} from '@avenlyo/ai';
import type { KnowledgeSource } from '@avenlyo/ai';
import type { IndustryPack } from '@avenlyo/industries';
import { z } from 'zod';

import { MAX_VOICE_TOOL_CALLS } from '../call/limits';
import type {
  VoiceCallContext,
  VoiceFunctionTool,
  VoiceToolCall,
  VoiceToolExecution,
} from '../call/types';

export const transferCallSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const transferCallFunction: VoiceFunctionTool = {
  description:
    'Transfer this caller to the configured business team when they request or need live help.',
  name: 'transfer_call',
  parameters: {
    additionalProperties: false,
    properties: {
      reason: { description: 'A concise operational reason for the transfer.', type: 'string' },
    },
    required: ['reason'],
    type: 'object',
  },
  strict: true,
};

function baseTool(
  tool: typeof searchBusinessKnowledgeFunction | typeof requestHumanHelpFunction,
): VoiceFunctionTool {
  return tool;
}

export function activeVoiceTools(input: {
  readonly industry: IndustryPack;
  readonly transferEnabled: boolean;
}): readonly VoiceFunctionTool[] {
  const tools: VoiceFunctionTool[] = [
    baseTool(searchBusinessKnowledgeFunction),
    baseTool(requestHumanHelpFunction),
  ];
  if (input.transferEnabled && input.industry.allowedActions.includes('handoff_to_human')) {
    tools.push(transferCallFunction);
  }
  return tools;
}

export interface VoiceToolServices {
  requestHumanHelp(
    input: {
      readonly reason: string;
      readonly toolCallId: string;
      readonly urgency: 'normal' | 'urgent';
    },
    context: VoiceCallContext,
  ): Promise<{ readonly created: boolean }>;
  searchBusinessKnowledge(
    input: { readonly query: string; readonly toolCallId: string },
    context: VoiceCallContext,
  ): Promise<readonly KnowledgeSource[]>;
  transferCall(
    input: { readonly reason: string; readonly toolCallId: string },
    context: VoiceCallContext,
  ): Promise<{ readonly transferred: boolean }>;
}

function output(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value);
}

function rejected(summary: string): VoiceToolExecution {
  return {
    handoffRequested: false,
    modelOutput: output({ ok: false, message: 'The requested action is unavailable.' }),
    status: 'rejected',
    summary,
    transferred: false,
  };
}

function reliableSources(matches: readonly KnowledgeSource[]): readonly KnowledgeSource[] {
  return matches
    .filter(
      (match) =>
        Number.isFinite(match.similarity) && match.similarity >= MIN_AGENT_KNOWLEDGE_SIMILARITY,
    )
    .slice(0, 3)
    .map((match) => ({
      content: match.content.slice(0, 1_200),
      similarity: Math.max(0, Math.min(1, match.similarity)),
      sourceUrl: match.sourceUrl,
      title: match.title.slice(0, 240),
    }));
}

/** Controlled, sequential live-call executor. Routing and transfer targets are never model inputs. */
export class VoiceToolExecutor {
  private readonly completed = new Map<string, VoiceToolExecution>();
  private executionCount = 0;

  public constructor(
    private readonly context: VoiceCallContext,
    private readonly services: VoiceToolServices,
    private readonly transferEnabled: boolean,
  ) {}

  public async execute(call: VoiceToolCall): Promise<VoiceToolExecution> {
    const previous = this.completed.get(call.callId);
    if (previous) return previous;
    if (this.executionCount >= MAX_VOICE_TOOL_CALLS) return rejected('Voice tool limit reached.');
    this.executionCount += 1;

    let rawArguments: unknown;
    try {
      rawArguments = JSON.parse(call.arguments) as unknown;
    } catch {
      return this.store(call.callId, rejected('Malformed tool arguments.'));
    }
    try {
      if (call.name === 'search_business_knowledge') {
        const parsed = searchBusinessKnowledgeSchema.safeParse(rawArguments);
        if (!parsed.success) {
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        }
        const matches = reliableSources(
          await this.services.searchBusinessKnowledge(
            { query: parsed.data.query, toolCallId: call.callId },
            this.context,
          ),
        );
        return this.store(call.callId, {
          handoffRequested: false,
          modelOutput: output({ matches }),
          status: 'succeeded',
          summary: matches.length
            ? `${matches.length} knowledge source(s) found.`
            : 'No reliable knowledge found.',
          transferred: false,
        });
      }
      if (call.name === 'request_human_help') {
        const parsed = requestHumanHelpSchema.safeParse(rawArguments);
        if (!parsed.success) {
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        }
        const handoff = await this.services.requestHumanHelp(
          { ...parsed.data, toolCallId: call.callId },
          this.context,
        );
        return this.store(
          call.callId,
          handoff.created
            ? {
                handoffRequested: true,
                modelOutput: output({ ok: true, requested: true }),
                status: 'succeeded',
                summary: 'Team handoff requested.',
                transferred: false,
              }
            : {
                handoffRequested: false,
                modelOutput: output({
                  ok: false,
                  message: 'The team could not be notified automatically.',
                }),
                status: 'failed',
                summary: 'Handoff was not created.',
                transferred: false,
              },
        );
      }
      if (call.name === 'transfer_call' && this.transferEnabled) {
        const parsed = transferCallSchema.safeParse(rawArguments);
        if (!parsed.success) {
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        }
        const transfer = await this.services.transferCall(
          { ...parsed.data, toolCallId: call.callId },
          this.context,
        );
        return this.store(
          call.callId,
          transfer.transferred
            ? {
                handoffRequested: true,
                modelOutput: output({ ok: true, transferred: true }),
                status: 'succeeded',
                summary: 'Configured transfer started.',
                transferred: true,
              }
            : {
                handoffRequested: false,
                modelOutput: output({
                  ok: false,
                  message: 'The call could not be transferred automatically.',
                }),
                status: 'failed',
                summary: 'Configured transfer failed.',
                transferred: false,
              },
        );
      }
      return this.store(call.callId, rejected('Unavailable tool requested.'));
    } catch {
      return this.store(call.callId, {
        handoffRequested: false,
        modelOutput: output({ ok: false, message: 'The requested action could not be completed.' }),
        status: 'failed',
        summary: 'Tool execution failed.',
        transferred: false,
      });
    }
  }

  private store(callId: string, result: VoiceToolExecution): VoiceToolExecution {
    this.completed.set(callId, result);
    return result;
  }
}
