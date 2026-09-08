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

  it('keeps compact multi-topic business pages focused with the default bounds', () => {
    const compactBusinessPage = [
      '# Avenlyo Dental Demo Clinic',
      'Location: Istanbul Main Clinic, Kadikoy, Istanbul.',
      'Hours: Monday-Friday 09:00-18:00. Saturday 10:00-15:00. Sunday closed.',
      'Languages: Turkish and English.',
      'Services: dental implant consultations, zirconium crowns, porcelain veneers, clear aligners, professional teeth whitening, and routine dental cleaning.',
      'New patients are accepted.',
      'Implant consultation fee: 1,350 TRY. Dental implant treatment prices are not quoted online; the final treatment price requires an in-person dentist examination.',
      'Appointments can be requested online. Same-day appointments are offered only when availability permits.',
    ].join('\n\n');

    const chunks = chunkKnowledgeContent(compactBusinessPage);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.content).toContain('Saturday 10:00-15:00');
    expect(chunks[1]?.content).toContain('Implant consultation fee: 1,350 TRY');
    expect(chunks.every((chunk) => chunk.content.length <= 500)).toBe(true);
  });
});
