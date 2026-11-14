export interface UsageEvent {
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  createdAt: string;
}

export class UsageTracker {
  private readonly events: UsageEvent[] = [];

  constructor (
    private readonly inputCostPerMillion: number,
    private readonly outputCostPerMillion: number
  ) {}

  record (operation: string, model: string, usage: { input_tokens?: number, output_tokens?: number }): void {
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    this.events.push({
      operation,
      model,
      inputTokens,
      outputTokens,
      estimatedCostUsd: (inputTokens * this.inputCostPerMillion + outputTokens * this.outputCostPerMillion) / 1_000_000,
      createdAt: new Date().toISOString()
    });
  }

  summary (): { requests: number, inputTokens: number, outputTokens: number, estimatedCostUsd: number, events: UsageEvent[] } {
    return {
      requests: this.events.length,
      inputTokens: this.events.reduce((sum, event) => sum + event.inputTokens, 0),
      outputTokens: this.events.reduce((sum, event) => sum + event.outputTokens, 0),
      estimatedCostUsd: this.events.reduce((sum, event) => sum + event.estimatedCostUsd, 0),
      events: [...this.events]
    };
  }
}
