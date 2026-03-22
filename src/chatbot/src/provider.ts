// Normalized types for provider-agnostic LLM interactions

export interface ProviderContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string | ProviderContentBlock[];
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderResponse {
  id: string;
  model: string;
  stopReason: string;
  content: ProviderContentBlock[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ChatParams {
  model: string;
  maxTokens: number;
  system: string;
  messages: ProviderMessage[];
  tools?: ProviderToolDefinition[];
}

export interface LLMProvider {
  readonly providerName: string;
  chat(params: ChatParams): Promise<{ response: ProviderResponse; ttftMs: number }>;
}
