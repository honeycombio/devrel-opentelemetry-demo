import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, ChatParams, ProviderResponse, ProviderContentBlock } from './provider.js';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 3,
    });
  }
  return _client;
}

export class AnthropicProvider implements LLMProvider {
  readonly providerName = 'anthropic';

  async chat(params: ChatParams): Promise<{ response: ProviderResponse; ttftMs: number }> {
    const client = getClient();

    // Translate tools: normalized `parameters` → Anthropic `input_schema`
    const tools = params.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));

    // Translate messages: normalized → Anthropic format
    const messages = params.messages.map(m => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: m.content };
      }
      // Translate content blocks
      const blocks = m.content.map(block => {
        if (block.type === 'tool_result') {
          return {
            type: 'tool_result' as const,
            tool_use_id: block.tool_use_id!,
            content: block.content ?? '',
          };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: block.id!,
            name: block.name!,
            input: block.input,
          };
        }
        return { type: 'text' as const, text: block.text ?? '' };
      });
      return { role: m.role, content: blocks };
    });

    const apiParams = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    } as Parameters<typeof client.messages.stream>[0];

    // Stream with TTFT measurement
    const startTime = performance.now();
    let ttftMs = -1;
    const stream = client.messages.stream(apiParams);
    stream.on('text', () => {
      if (ttftMs < 0) {
        ttftMs = performance.now() - startTime;
      }
    });
    const raw = await stream.finalMessage();
    if (ttftMs < 0) {
      ttftMs = performance.now() - startTime;
    }

    // Normalize response
    const content: ProviderContentBlock[] = raw.content.map(block => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      }
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
      return { type: block.type as ProviderContentBlock['type'] };
    });

    const response: ProviderResponse = {
      id: raw.id,
      model: raw.model,
      stopReason: raw.stop_reason ?? 'unknown',
      content,
      usage: {
        inputTokens: raw.usage.input_tokens,
        outputTokens: raw.usage.output_tokens,
      },
    };

    return { response, ttftMs };
  }
}
