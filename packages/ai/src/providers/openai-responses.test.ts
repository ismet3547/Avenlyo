import { veterinaryPack } from '@avenlyo/industries';
import { describe, expect, it } from 'vitest';

import { buildResponsesRequest } from './openai-responses';
import { activeToolsForIndustry } from '../tools/registry';

describe('OpenAI Responses request contract', () => {
  it('always disables provider-side response storage and parallel tool execution', () => {
    const request = buildResponsesRequest({
      input: [{ content: 'Hello', role: 'user', type: 'message' }],
      instructions: 'Follow policy.',
      maxOutputTokens: 500,
      model: 'gpt-5.6',
      tools: activeToolsForIndustry(veterinaryPack),
    });

    expect(request.store).toBe(false);
    expect(request.parallel_tool_calls).toBe(false);
    expect(request).not.toHaveProperty('previous_response_id');
    expect(request.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parameters: expect.objectContaining({ additionalProperties: false }),
          strict: true,
          type: 'function',
        }),
      ]),
    );
    expect(request.tools?.map((tool) => tool.type)).not.toContain('web_search');
    expect(request.tools?.map((tool) => tool.type)).not.toContain('file_search');
  });
});
