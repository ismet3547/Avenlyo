type Environment = Record<string, string | undefined>;

interface EnvironmentIssue {
  message: string;
  path: readonly PropertyKey[];
}

type EnvironmentParseResult<Value> =
  | { data: Value; success: true }
  | { error: { issues: readonly EnvironmentIssue[] }; success: false };

interface EnvironmentSchema<Value> {
  safeParse(input: unknown): EnvironmentParseResult<Value>;
}

export class EnvironmentValidationError extends Error {
  public constructor(issues: readonly EnvironmentIssue[]) {
    const detail = issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join(', ');

    super(`Invalid environment configuration: ${detail}`);
    this.name = 'EnvironmentValidationError';
  }
}

/**
 * Parse an application's environment once at its boundary. Applications own their schema while
 * this utility keeps validation behaviour and errors consistent across runtimes.
 */
export function parseEnvironment<Value>(
  schema: EnvironmentSchema<Value>,
  environment: Environment = process.env,
): Value {
  const result = schema.safeParse(environment);

  if (!result.success) {
    throw new EnvironmentValidationError(result.error.issues);
  }

  return result.data;
}
