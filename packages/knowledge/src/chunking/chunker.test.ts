import { describe, expect, it } from 'vitest';

import { chunkKnowledgeContent } from './chunker';

describe('knowledge chunker', () => {
  const content = [
    '# Services',
    'First useful paragraph with enough context for a customer.',
    '## Prevention',
    'Second useful paragraph with dental cleaning, vaccines, and more helpful details.',
    'Third paragraph that keeps the ordering stable.',
  ].join('\n\n');

  it('is deterministic, ordered, non-empty, and retains heading context', () => {
    const first = chunkKnowledgeContent(content, { maxCharacters: 100, overlapCharacters: 20 });
    const second = chunkKnowledgeContent(content, { maxCharacters: 100, overlapCharacters: 20 });
    expect(first).toEqual(second);
    expect(first.every((chunk) => chunk.content.length >= 40)).toBe(true);
    expect(first.map((chunk) => chunk.chunkIndex)).toEqual(first.map((_, index) => index));
    expect(first[0]?.content).toContain('# Services');
  });
});
