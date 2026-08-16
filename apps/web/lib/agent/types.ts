export interface AgentTestSourceReference {
  readonly sourceUrl: string | null;
  readonly title: string;
}

export interface AgentTestToolExecution {
  readonly name: string;
  readonly status: 'failed' | 'rejected' | 'succeeded';
}

export interface AgentTestTurn {
  readonly failureCode:
    'invalid_tool_call' | 'loop_limit' | 'provider_error' | 'tool_failure' | null;
  readonly handoffRequested: boolean;
  readonly model: string;
  readonly sources: readonly AgentTestSourceReference[];
  readonly text: string;
  readonly tools: readonly AgentTestToolExecution[];
}
