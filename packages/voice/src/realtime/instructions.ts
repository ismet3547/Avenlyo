import { buildAgentInstructions, buildLiveContext } from '@avenlyo/ai';

import type { VoiceBusinessContext, VoiceCallContext } from '../call/types';

export const voiceCoreInstructions = `
VOICE-SPECIFIC RULES
Speak naturally and briefly using short sentences. Ask one question at a time. Do not read URLs aloud unless needed. Do not narrate tool calls. Do not claim an action succeeded unless the tool succeeded. Do not invent availability, prices, bookings, services, or policies. You are Avenlyo's AI Front Office, not a human employee.`;

export function buildVoiceInstructions(
  context: VoiceCallContext,
  business: VoiceBusinessContext,
): string {
  return `${buildAgentInstructions(context.industry, business, buildLiveContext(business.timezone))}\n${voiceCoreInstructions}`;
}

export function initialVoiceGreeting(businessName: string): string {
  return `Thanks for calling ${businessName}. I’m Avenlyo’s AI Front Office. How can I help?`;
}
