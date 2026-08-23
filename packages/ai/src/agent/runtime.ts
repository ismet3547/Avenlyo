import { createHash } from 'node:crypto';

import { buildBoundedConversationContext, buildLiveContext } from './context-builder';
import {
  MAX_OUTPUT_TOKENS,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_ROUNDS,
  MAX_USER_MESSAGE_CHARACTERS,
} from './limits';
import { buildAgentInstructions } from './prompt-builder';
import { requiresBusinessKnowledge } from './business-knowledge-predicate';
import type { KnowledgeSearchDiagnostic } from './knowledge-reliability';
import type {
  AgentExecutionContext,
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

/**
 * One runtime-forced knowledge search per turn.
 *
 * It can only happen when the model made no search of its own, so it never stacks on top of the
 * trusted-query recovery inside the executor: the two are reached by mutually exclusive paths, and
 * the worst case for a turn is therefore the model's own tool calls plus a single extra search.
 */
const MAX_RUNTIME_FORCED_SEARCHES_PER_TURN = 1;

/**
 * How the retrieved sources are handed back to the model.
 *
 * Says plainly that Avenlyo performed the search, because the model did not, and the transcript
 * should not imply otherwise.
 */
function runtimeKnowledgeInput(sources: readonly KnowledgeSource[]): string {
  return `Avenlyo searched published business knowledge for this customer question because no knowledge tool call was made. Answer only from these sources; if they do not contain the answer, say you do not have reliable information.\n${JSON.stringify(
    { matches: sources },
  )}`;
}

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
    const instructions = `${buildAgentInstructions(input.industry, input.business, live)}\n\n${
      input.context.channel === 'sms'
        ? 'CHANNEL: SMS. Keep one response concise (normally 600â€“800 characters or less). Do not send a burst of separate messages. If a safety or handoff response needs more space, prioritize the complete safety/handoff instruction over detail.'
        : input.context.channel === 'web'
          ? 'CHANNEL: Website chat. Be concise, but you may provide a little more detail than SMS.'
          : ''
    }`;
    const providerInput: AgentProviderInputItem[] = [
      ...buildBoundedConversationContext(input.history, userMessage),
    ];
    const executions: AgentToolExecution[] = [];
    const knowledgeDiagnostics: KnowledgeSearchDiagnostic[] = [];
    const sources: KnowledgeSource[] = [];
    // The trusted current customer utterance, handed to tools alongside the routing identity. It
    // comes from the turn this runtime was given, never from the model, so a tool can tell whether
    // the model searched the real question instead of taking the model's word for it.
    const toolContext: AgentExecutionContext = {
      ...input.context,
      customerMessage: userMessage,
    };
    let handoffRequested = false;
    let toolCalls = 0;
    let latestUsage: AgentTurnResult['usage'];
    const executedCallIds = new Set<string>();
    let knowledgeSearchAttempted = false;
    let reliableKnowledgeFound = false;
    let runtimeForcedSearches = 0;

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
          knowledgeDiagnostics,
          toolCalls: executions,
        };
      }
      latestUsage = providerResult.usage;

      if (providerResult.toolCalls.length === 0) {
        // The model wants to finish. If it never searched and the question needed searching, its
        // answer is an assertion about a business it has not consulted -- which is exactly how
        // staging got told "there is no registration link" about a page published minutes before.
        // The prompt already asked for a search; an instruction the model can decline is not a
        // control, so the runtime does the search itself rather than trusting the answer.
        const groundingRequired =
          !knowledgeSearchAttempted &&
          runtimeForcedSearches < MAX_RUNTIME_FORCED_SEARCHES_PER_TURN &&
          requiresBusinessKnowledge(userMessage);

        if (groundingRequired) {
          runtimeForcedSearches += 1;
          // No executor knowledge service means no way to ground the claim, so the answer is
          // refused rather than allowed through unchecked.
          const forced = await this.executor.searchKnowledgeForRuntime?.(
            userMessage,
            toolContext,
          );
          if (forced) knowledgeDiagnostics.push(forced.diagnostic);
          if (forced && forced.sources.length > 0) {
            sources.push(...forced.sources);
            reliableKnowledgeFound = true;
            knowledgeSearchAttempted = true;
            providerInput.push({
              content: runtimeKnowledgeInput(forced.sources),
              type: 'runtime_knowledge',
            });
            // Round again so the model answers from the evidence it declined to fetch.
            continue;
          }
          return {
            handoffRequested,
            model: this.model,
            sources: distinctSources(sources),
            // The model's ungrounded answer is discarded, not softened.
            text: unknownKnowledgeReply,
            knowledgeDiagnostics,
            toolCalls: executions,
            usage: latestUsage,
          };
        }

        return {
          handoffRequested,
          model: this.model,
          sources: distinctSources(sources),
          text:
            knowledgeSearchAttempted && !reliableKnowledgeFound
              ? unknownKnowledgeReply
              : responseText(providerResult.text),
          knowledgeDiagnostics,
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
            knowledgeDiagnostics,
            toolCalls: executions,
            usage: latestUsage,
          };
        }

        const result = await this.executor.execute(call, toolContext);
        executions.push(result.execution);
        handoffRequested ||= result.handoffRequested;
        sources.push(...result.sources);
        if (call.name === 'search_business_knowledge') {
          knowledgeSearchAttempted = true;
          reliableKnowledgeFound ||= result.knowledgeOutcome === 'reliable';
          if (result.knowledgeDiagnostic) knowledgeDiagnostics.push(result.knowledgeDiagnostic);
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
      knowledgeDiagnostics,
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
