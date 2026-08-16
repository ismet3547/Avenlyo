import 'server-only';

import { parseEnvironment } from '@avenlyo/shared';
import { z } from 'zod';

/** Optional server-only settings: public pages and draft review work without OpenAI configured. */
export const knowledgeServerEnv = parseEnvironment(
  z.object({
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_AGENT_MODEL: z.string().min(1).default('gpt-5.6'),
    OPENAI_EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  }),
  {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_AGENT_MODEL: process.env.OPENAI_AGENT_MODEL,
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL,
  },
);
