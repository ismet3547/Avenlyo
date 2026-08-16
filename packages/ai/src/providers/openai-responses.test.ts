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
    expect(request.include).toContain('reasoning.encrypted_content');
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

  it('replays encrypted reasoning continuation with function output in every stateless tool round', () => {
    const request = buildResponsesRequest({
      input: [
        {
          continuation: {
            encryptedReasoningItems: [{ encryptedContent: 'opaque-only', id: 'rsn_1' }],
            provider: 'openai-responses',
          },
          type: 'provider_continuation',
        },
        {
          arguments: '{"query":"hours"}',
          callId: 'call_1',
          name: 'search_business_knowledge',
          type: 'function_call',
        },
        { callId: 'call_1', output: '{"matches":[]}', type: 'function_call_output' },
      ],
      instructions: 'Follow policy.',
      maxOutputTokens: 500,
      model: 'gpt-5.6',
      tools: activeToolsForIndustry(veterinaryPack),
    });
    expect(request.input).toEqual([
      expect.objectContaining({
        encrypted_content: 'opaque-only',
        id: 'rsn_1',
        type: 'reasoning',
      }),
      expect.objectContaining({ call_id: 'call_1', type: 'function_call' }),
      expect.objectContaining({ call_id: 'call_1', type: 'function_call_output' }),
    ]);
    expect(request.store).toBe(false);
    expect(request.parallel_tool_calls).toBe(false);
    expect(request).not.toHaveProperty('previous_response_id');
  });
});
