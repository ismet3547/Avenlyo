import { bootstrapRuntime } from './bootstrap.js';

/**
 * Production entry point. Every decision the startup sequence makes lives in `bootstrap.ts` so it
 * can be tested with injected dependencies; this file only runs it.
 */
await bootstrapRuntime();
