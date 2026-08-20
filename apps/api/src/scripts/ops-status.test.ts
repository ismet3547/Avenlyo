import { beforeEach, describe, expect, it, vi } from 'vitest';

const createServiceSupabaseClient = vi.fn();

vi.mock('../lib/supabase.js', () => ({
  createServiceSupabaseClient: (): unknown => createServiceSupabaseClient() as unknown,
}));

const { OPS_EXIT_DATABASE_UNAVAILABLE, runOpsStatus } = await import('./ops-status.js');

/**
 * The operator CLI runs with the service-role key, so anything it prints is printed by someone
 * holding the most privileged credential Avenlyo has. A rejected RPC used to reach Node's default
 * handler, which prints the error message and stack verbatim.
 */
const LEAKY_MESSAGE =
  'FetchError: request to https://secret-db-host.example.internal/rest/v1/rpc failed, ' +
  'apikey=eyJhbGciOiJIUzI1NiJ9.service-role-secret';

function leakyError(): Error {
  return Object.assign(new Error(LEAKY_MESSAGE), { code: 'ENOTFOUND' });
}

beforeEach(() => {
  createServiceSupabaseClient.mockReset();
});

describe('ops:status database failure handling', () => {
  it('reports a fixed message and a safe exit code when the readiness probe rejects', async () => {
    createServiceSupabaseClient.mockReturnValue({
      rpc: vi.fn(() => Promise.reject(leakyError())),
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runOpsStatus({
      argv: [],
      stderr: (t) => stderr.push(t),
      stdout: (t) => stdout.push(t),
    });

    expect(code).toBe(OPS_EXIT_DATABASE_UNAVAILABLE);
    expect(code).not.toBe(0);
    const output = [...stdout, ...stderr].join('');
    expect(output).toContain('The database did not answer');
    expect(output).not.toContain('secret-db-host');
    expect(output).not.toContain('https://');
    expect(output).not.toContain('Error:');
    expect(output).not.toContain('service-role-secret');
    expect(output).not.toContain('apikey');
    expect(output).not.toContain('at ');
  });

  it('handles a rejected runtime or snapshot call the same way', async () => {
    const rpc = vi.fn((name: string) => {
      if (name === 'platform_readiness_probe') {
        return Promise.resolve({ data: [{ checked_at: 'now', schema_version: 14 }], error: null });
      }
      return Promise.reject(leakyError());
    });
    createServiceSupabaseClient.mockReturnValue({ rpc });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runOpsStatus({
      argv: [],
      stderr: (t) => stderr.push(t),
      stdout: (t) => stdout.push(t),
    });

    expect(code).toBe(OPS_EXIT_DATABASE_UNAVAILABLE);
    const output = [...stdout, ...stderr].join('');
    expect(output).not.toContain('secret-db-host');
    expect(output).not.toContain('https://');
    expect(output).not.toContain('Error:');
  });

  it('reports a returned database error with the same fixed message as a thrown one', async () => {
    createServiceSupabaseClient.mockReturnValue({
      rpc: vi.fn(() => Promise.resolve({ data: null, error: { message: LEAKY_MESSAGE } })),
    });
    const stderr: string[] = [];

    const code = await runOpsStatus({ argv: [], stderr: (t) => stderr.push(t), stdout: () => {} });

    expect(code).toBe(OPS_EXIT_DATABASE_UNAVAILABLE);
    expect(stderr.join('')).not.toContain('secret-db-host');
  });
});
