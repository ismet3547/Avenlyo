import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EnvironmentValidationError, parseEnvironment } from './env.js';

describe('parseEnvironment', () => {
  const schema = z.object({
    PORT: z.coerce.number().int().positive().default(4000),
    NAME: z.string().min(1),
  });

  it('returns typed, coerced environment values', () => {
    const environment = parseEnvironment(schema, { NAME: 'Avenlyo', PORT: '5000' });

    expect(environment).toEqual({ NAME: 'Avenlyo', PORT: 5000 });
  });

  it('uses schema defaults for omitted values', () => {
    const environment = parseEnvironment(schema, { NAME: 'Avenlyo' });

    expect(environment.PORT).toBe(4000);
  });

  it('provides a focused error for invalid values', () => {
    expect(() => parseEnvironment(schema, { NAME: '', PORT: 'not-a-number' })).toThrow(
      EnvironmentValidationError,
    );
  });
});
