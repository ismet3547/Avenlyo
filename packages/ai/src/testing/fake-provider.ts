import type { AgentProvider, AgentProviderInput, AgentProviderResult } from '../agent/types';

type FakeResult = AgentProviderResult | Error;

/** Deterministic provider for CI: it never issues an OpenAI request. */
export class FakeAgentProvider implements AgentProvider {
  public readonly id = 'fake-agent-provider';
  public readonly inputs: AgentProviderInput[] = [];
  private readonly results: FakeResult[];

  public constructor(results: readonly FakeResult[]) {
    this.results = [...results];
  }

  public runTurn(input: AgentProviderInput): Promise<AgentProviderResult> {
    this.inputs.push(input);
    const result = this.results.shift();
    if (!result)
      return Promise.reject(new Error('Fake provider has no remaining scripted result.'));
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  }
}
