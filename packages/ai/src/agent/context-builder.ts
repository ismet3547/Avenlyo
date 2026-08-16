import {
  MAX_HISTORY_CHARACTERS,
  MAX_HISTORY_MESSAGES,
  MAX_USER_MESSAGE_CHARACTERS,
} from './limits';
import type { AgentConversationMessage, AgentLiveContext, AgentProviderInputItem } from './types';

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

/** Uses deterministic recent-message and character bounds owned by Avenlyo. */
export function buildBoundedConversationContext(
  history: readonly AgentConversationMessage[],
  userMessage: string,
): readonly AgentProviderInputItem[] {
  const candidates = history.slice(-MAX_HISTORY_MESSAGES);
  const selected: AgentConversationMessage[] = [];
  let characterCount = 0;

  for (const message of [...candidates].reverse()) {
    const content = truncate(message.content.trim(), MAX_USER_MESSAGE_CHARACTERS);
    if (!content || characterCount + content.length > MAX_HISTORY_CHARACTERS) continue;
    selected.unshift({ content, role: message.role });
    characterCount += content.length;
  }

  const currentMessage = truncate(userMessage.trim(), MAX_USER_MESSAGE_CHARACTERS);
  return [
    ...selected.map((message) => ({
      content: message.content,
      role: message.role === 'customer' ? ('user' as const) : ('assistant' as const),
      type: 'message' as const,
    })),
    { content: currentMessage, role: 'user' as const, type: 'message' as const },
  ];
}

/** Formats server time in the business's IANA timezone; invalid stored zones safely fall back to UTC. */
export function buildLiveContext(timezone: string, now = new Date()): AgentLiveContext {
  try {
    return {
      localDateTime: new Intl.DateTimeFormat('en-CA', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: timezone,
      }).format(now),
    };
  } catch {
    return {
      localDateTime: new Intl.DateTimeFormat('en-CA', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(now),
    };
  }
}
