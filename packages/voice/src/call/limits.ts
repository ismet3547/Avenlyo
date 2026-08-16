/** A server-owned cap; callers and models cannot extend a metered live call. */
export const MAX_CALL_DURATION_MS = 30 * 60 * 1_000;

/** OpenAI Server VAD prompts after a normal pause; two such idle periods close the call. */
export const MAX_CONSECUTIVE_IDLE_TIMEOUTS = 2;

/** Bound sequential side-effect tool work for one live customer call. */
export const MAX_VOICE_TOOL_CALLS = 8;

export const VOICE_IDLE_TIMEOUT_MS = 20_000;
