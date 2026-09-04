// The model-agnostic agent loop: feed system + task, then repeatedly ask the model for
// the next action, execute its tool calls in the sandbox, feed results back, until it
// calls `finish` or hits maxSteps. This is the only place model and sandbox meet, and
// it depends on both only through their interfaces.

import type { ModelClient, ModelMessage } from '../model/model-client.js';
import type { Sandbox } from '../sandbox/sandbox.js';
import { executeTool, toolSpecs } from './tools.js';

export interface AgentResult {
  finished: boolean;
  summary: string;
  steps: number;
}

export async function runAgent(input: {
  model: ModelClient;
  sandbox: Sandbox;
  system: string;
  task: string;
  maxSteps?: number;
  log: (msg: string) => void;
}): Promise<AgentResult> {
  const { model, sandbox, system, task, log } = input;
  const maxSteps = input.maxSteps ?? 12;

  const messages: ModelMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: task },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    const turn = await model.complete(messages, toolSpecs);
    if (turn.text) log(`  model: ${turn.text.slice(0, 200)}`);

    if (turn.toolCalls.length === 0) {
      // No tool call and no finish — treat the text as the final answer.
      return { finished: true, summary: turn.text || '(no summary)', steps: step };
    }

    messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });

    for (const call of turn.toolCalls) {
      log(`  → ${call.name}(${JSON.stringify(call.arguments).slice(0, 120)})`);
      const outcome = await executeTool(sandbox, call);
      messages.push({ role: 'tool', content: outcome.result, toolCallId: call.id });
      if (outcome.finished) {
        return { finished: true, summary: outcome.summary ?? '', steps: step };
      }
    }
  }

  return { finished: false, summary: `hit maxSteps (${maxSteps}) without finishing`, steps: maxSteps };
}
