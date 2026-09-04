// OpenAICompatibleModel — talks to any OpenAI-shaped /chat/completions endpoint.
// Point MODEL_BASE_URL at OpenRouter, a self-hosted LiteLLM proxy, OpenAI, Together,
// Groq, or Ollama, set MODEL_NAME, and the provider is swapped with zero code change.
// Uses native fetch — no SDK dependency, so the orchestrator has no runtime deps.

import type { AssistantTurn, ModelClient, ModelMessage, ToolSpec } from './model-client.js';

interface OpenAIToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export class OpenAICompatibleModel implements ModelClient {
  readonly name: string;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.name = `openai-compatible:${model}`;
  }

  async complete(messages: ModelMessage[], tools: ToolSpec[]): Promise<AssistantTurn> {
    const body = {
      model: this.model,
      messages: messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id,
              type: 'function',
              function: { name: t.name, arguments: JSON.stringify(t.arguments) },
            })),
          };
        }
        return { role: m.role, content: m.content };
      }),
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
      temperature: 0,
    };

    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`model call failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string | null; tool_calls?: OpenAIToolCall[] } }>;
    };
    const message = json.choices[0]?.message ?? { content: '' };
    return {
      text: message.content ?? '',
      toolCalls: (message.tool_calls ?? []).map((t) => ({
        id: t.id,
        name: t.function.name,
        arguments: safeParse(t.function.arguments),
      })),
    };
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
