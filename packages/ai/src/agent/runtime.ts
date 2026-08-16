import { createHash } from 'node:crypto';

import { buildBoundedConversationContext, buildLiveContext } from './context-builder';
import {
  MAX_OUTPUT_TOKENS,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_ROUNDS,
  MAX_USER_MESSAGE_CHARACTERS,
} from './limits';
import { buildAgentInstructions } from './prompt-builder';
import type {
  AgentProvider,
  AgentProviderInputItem,
  AgentToolCall,
  AgentToolExecution,
  AgentTurnInput,
  AgentTurnResult,
  KnowledgeSource,
} from './types';
import { detectSafetyEscalation } from '../policy/safety';
import { policyHandoffCallId } from '../tools/executor';
import type { ToolExecutor } from '../tools/types';

const providerFailureReply = 'Avenlyo couldn’t respond right now. Please try again.';
const loopLimitReply =
  'I couldn’t complete that request safely. I can ask the team to help with it.';
const unknownKnowledgeReply =
  "I don't have reliable information about that yet. I can ask the team to help.";

function responseText(value: string): string {
  const trimmed = value.trim();
  return trimmed || 'I don’t have a reliable answer for that yet. I can ask the team to help.';
}

function distinctSources(sources: readonly KnowledgeSource[]): readonly KnowledgeSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.title}:${source.sourceUrl ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function policyCall(
  context: AgentTurnInput['context'],
  message: string,
  urgency: 'normal' | 'urgent',
): AgentToolCall {
  return {
    arguments: JSON.stringify({
      reason: 'Avenlyo safety policy requires a human handoff for this message.',
      urgency,
    }),
    callId: policyHandoffCallId(context, message),
    name: 'request_human_help',
  };
}

/**
 * Provider-independent bounded agent loop. Authentication, Supabase, and channel concerns are
 * intentionally outside this class; callers supply a trusted context and controlled executor.
 */
export class AgentRuntime {
  public constructor(
    private readonly provider: AgentProvider,
    private readonly executor: ToolExecutor,
    private readonly model: string,
  ) {}

  public async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const userMessage = input.userMessage.trim().slice(0, MAX_USER_MESSAGE_CHARACTERS);
    if (!userMessage) {
      return {
        handoffRequested: false,
        model: this.model,
        sources: [],
        text: 'Please enter a message to test the AI Front Office.',
        toolCalls: [],
      };
    }

    const safety = detectSafetyEscalation(input.industry, userMessage);
    if (safety && this.executor.tools.some((tool) => tool.name === 'request_human_help')) {
      const result = await this.executor.execute(
        policyCall(input.context, userMessage, safety.urgency),
        input.context,
      );
      return {
        failureCode: result.handoffRequested ? undefined : 'tool_failure',
        handoffRequested: result.handoffRequested,
        model: this.model,
        sources: [],
        text: result.handoffRequested
          ? safety.reply
          : 'I wasn’t able to notify the team automatically. Please contact the business directly.',
        toolCalls: [result.execution],
      };
    }

    const live = buildLiveContext(input.business.timezone);
    const instructions = buildAgentInstructions(input.industry, input.business, live);
    const providerInput: AgentProviderInputItem[] = [
      ...buildBoundedConversationContext(input.history, userMessage),
    ];
    const executions: AgentToolExecution[] = [];
    const sources: KnowledgeSource[] = [];
    let handoffRequested = false;
    let toolCalls = 0;
    let latestUsage: AgentTurnResult['usage'];
    const executedCallIds = new Set<string>();
    let knowledgeSearchAttempted = false;
    let reliableKnowledgeFound = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      let providerResult;
      try {
        providerResult = await this.provider.runTurn({
          input: providerInput,
          instructions,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          model: this.model,
          tools: this.executor.tools,
        });
      } catch {
        return {
          failureCode: 'provider_error',
          handoffRequested,
          model: this.model,
          sources: distinctSources(sources),
          text: providerFailureReply,
          toolCalls: executions,
        };
      }
      latestUsage = providerResult.usage;

      if (providerResult.toolCalls.length === 0) {
        return {
          handoffRequested,
          model: this.model,
          sources: distinctSources(sources),
          text:
            knowledgeSearchAttempted && !reliableKnowledgeFound
              ? unknownKnowledgeReply
              : responseText(providerResult.text),
          toolCalls: executions,
          usage: latestUsage,
        };
      }

      if (providerResult.continuation) {
        providerInput.push({
          continuation: providerResult.continuation,
          type: 'provider_continuation',
        });
      }

      for (const call of providerResult.toolCalls) {
        if (executedCallIds.has(call.callId)) {
          const duplicate: AgentToolExecution = {
            callId: call.callId,
            name: call.name,
            status: 'rejected',
            summary: 'Duplicate tool call ignored.',
          };
          executions.push(duplicate);
          providerInput.push(
            {
              arguments: call.arguments,
              callId: call.callId,
              name: call.name,
              type: 'function_call',
            },
            {
              callId: call.callId,
              output: JSON.stringify({ ok: false, message: 'Duplicate tool call ignored.' }),
              type: 'function_call_output',
            },
          );
          continue;
        }
        executedCallIds.add(call.callId);
        toolCalls += 1;
        if (toolCalls > MAX_TOOL_CALLS_PER_TURN) {
          return {
            failureCode: 'loop_limit',
            handoffRequested,
            model: this.model,
            sources: distinctSources(sources),
            text: loopLimitReply,
            toolCalls: executions,
            usage: latestUsage,
          };
        }

        const result = await this.executor.execute(call, input.context);
        executions.push(result.execution);
        handoffRequested ||= result.handoffRequested;
        sources.push(...result.sources);
        if (call.name === 'search_business_knowledge') {
          knowledgeSearchAttempted = true;
          reliableKnowledgeFound ||= result.knowledgeOutcome === 'reliable';
        }
        providerInput.push(
          {
            arguments: call.arguments,
            callId: call.callId,
            name: call.name,
            type: 'function_call',
          },
          { callId: call.callId, output: result.modelOutput, type: 'function_call_output' },
        );
      }
    }

    return {
      failureCode: 'loop_limit',
      handoffRequested,
      model: this.model,
      sources: distinctSources(sources),
      text: loopLimitReply,
      toolCalls: executions,
      usage: latestUsage,
    };
  }
}

/** A debug-safe deterministic identifier for grouping run metadata; never sent to a provider. */
export function agentTurnFingerprint(input: AgentTurnInput): string {
  return createHash('sha256')
    .update(`${input.context.conversationId}:${input.userMessage}`)
    .digest('hex');
}
