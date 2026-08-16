import type { EzyVetTransport, EzyVetTransportRequest, EzyVetTransportResponse } from '../ezyvet/types';

export class FakeEzyVetTransport implements EzyVetTransport {
  public readonly requests: EzyVetTransportRequest[] = [];
  private readonly responses: Array<EzyVetTransportResponse | Error> = [];

  public enqueue(response: EzyVetTransportResponse | Error): void {
    this.responses.push(response);
  }

  public request(input: EzyVetTransportRequest): Promise<EzyVetTransportResponse> {
    this.requests.push(input);
    const response = this.responses.shift();
    if (!response) return Promise.reject(new Error('No fake ezyVet response was queued.'));
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  }
}
