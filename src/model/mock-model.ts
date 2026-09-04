// MockModel — a scripted ModelClient so the whole orchestrator runs offline, with no
// API key and no provider. It emits a fixed, realistic sequence of tool calls (read the
// first contract file → write every scaffold file → stage + diff → finish), proving the
// loop end to end against any codebase that has an integration profile. Swap it for
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
    const id = (suffix: string) => `mock-${this.step}-${suffix}`;
    const contract = this.contractFiles[0];
    const paths = this.scaffold.files.map((f) => f.relPath);
    const script: AssistantTurn[] = [
      ...(contract
        ? [{
            text: 'Reading the contract to understand the required members.',
            toolCalls: [{ id: id('read'), name: 'read_file', arguments: { path: contract } }],
          }]
        : []),
      {
        text: `Scaffolding the ${this.scaffold.integrationName} integration (${paths.length} file${paths.length === 1 ? '' : 's'}).`,
        toolCalls: this.scaffold.files.map((file, index) => ({
          id: id(`write${index}`),
          name: 'write_file',
          arguments: { path: file.relPath, content: file.content },
        })),
      },
      {
        text: 'Staging and reviewing the diff.',
        toolCalls: [{ id: id('diff'), name: 'exec', arguments: { command: 'git add -A && git diff --cached --stat' } }],
      },
      {
        text: 'Done.',
        toolCalls: [{
          id: id('finish'),
          name: 'finish',
          arguments: {
            summary: `Scaffolded ${paths.join(', ')}.${this.scaffold.registration.length ? ` Registration TODOs: ${this.scaffold.registration.join('; ')}.` : ''}`,
          },
        }],
      },
    ];
    const turn = script[Math.min(this.step, script.length - 1)];
    this.step += 1;
    return turn;
  }
}
