import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('web liveness', () => {
  it('reports that the web server is serving', async () => {
    const response = GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ service: 'avenlyo-web', status: 'ok' });
    expect(typeof body.release).toBe('string');
  });

  it('exposes nothing beyond the safe liveness shape', async () => {
    const response = GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['release', 'service', 'status', 'timestamp']);
    const serialized = JSON.stringify(body).toUpperCase();
    for (const forbidden of ['SUPABASE', 'HTTP://', 'HTTPS://', 'KEY', 'TOKEN', 'COOKIE']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
