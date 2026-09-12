import { describe, expect, it } from 'vitest';

import { plainTextResponse } from '../providers/openai-responses.js';

describe('plain-text model presentation', () => {
  it('strips common Markdown while preserving readable prices, labels and URLs', () => {
    expect(plainTextResponse('**1.350 TL** — [Bilgi](https://example.com) `not` ## Başlık')).toBe(
      '1.350 TL — Bilgi (https://example.com) not ## Başlık',
    );
    expect(plainTextResponse('## Başlık\n__Alt__ ~~eski~~')).toBe('Başlık\nAlt eski');
  });
});
