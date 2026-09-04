// Provider-agnostic model interface. The agent loop depends only on this, so the
// brain can be Claude, GPT, Gemini, Llama, or a local model — chosen by config, never
// by code. Two implementations ship: OpenAICompatibleModel (any OpenAI-shaped gateway:
// OpenRouter, LiteLLM, OpenAI, Together, Groq, Ollama) and MockModel (offline demo).

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant turns that requested tools */
  toolCalls?: ToolCall[];
  /** tool-result messages */
  toolCallId?: string;
}

export interface AssistantTurn {
  text: string;
  toolCalls: ToolCall[];
}

export interface ModelClient {
  readonly name: string;
  complete(messages: ModelMessage[], tools: ToolSpec[]): Promise<AssistantTurn>;
}
