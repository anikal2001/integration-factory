// MockModel — a scripted ModelClient so the whole orchestrator runs offline, with no
// API key and no provider. It emits a fixed, realistic sequence of tool calls (read the
// first contract file → write the profile's scaffold → stage + diff → finish), proving
// the loop end to end against any codebase that has an integration profile. Swap it for
// OpenAICompatibleModel by setting MODEL_API_KEY; nothing else changes.

import type { AssistantTurn, ModelClient, ModelMessage, ToolSpec } from './model-client.js';
import type { ScaffoldPlan } from '../tasks/scaffold.js';

export class MockModel implements ModelClient {
  readonly name = 'mock';
  private step = 0;
  constructor(
    private readonly scaffold: ScaffoldPlan,
    private readonly contractFiles: string[],
  ) {}

  async complete(_messages: ModelMessage[], _tools: ToolSpec[]): Promise<AssistantTurn> {
    const id = `mock-${this.step}`;
    const contract = this.contractFiles[0];
    const script: AssistantTurn[] = [
      ...(contract
        ? [{
            text: 'Reading the contract to understand the required members.',
            toolCalls: [{ id, name: 'read_file', arguments: { path: contract } }],
          }]
        : []),
      {
        text: `Scaffolding the ${this.scaffold.integrationName} integration.`,
        toolCalls: [{ id, name: 'write_file', arguments: { path: this.scaffold.relPath, content: this.scaffold.content } }],
      },
      {
        text: 'Staging and reviewing the diff.',
        toolCalls: [{ id, name: 'exec', arguments: { command: 'git add -A && git diff --cached --stat' } }],
      },
      {
        text: 'Done.',
        toolCalls: [{
          id,
          name: 'finish',
          arguments: {
            summary: `Scaffolded ${this.scaffold.relPath}.${this.scaffold.registration.length ? ` Registration TODOs: ${this.scaffold.registration.join('; ')}.` : ''}`,
          },
        }],
      },
    ];
    const turn = script[Math.min(this.step, script.length - 1)];
    this.step += 1;
    return turn;
  }
}
