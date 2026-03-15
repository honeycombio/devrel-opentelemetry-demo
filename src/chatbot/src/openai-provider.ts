import OpenAI from 'openai';
import type { LLMProvider, ChatParams, ProviderResponse, ProviderContentBlock, ProviderMessage } from './provider.js';

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 3,
    });
  }
  return _client;
}

// Translate normalized messages to OpenAI chat format
function translateMessages(
  system: string,
  messages: ProviderMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Handle array content blocks
    if (msg.role === 'assistant') {
      // Collect text and tool_use blocks into a single assistant message
      const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
      const toolCalls = msg.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          id: b.id!,
          type: 'function' as const,
          function: { name: b.name!, arguments: JSON.stringify(b.input ?? {}) },
        }));

      const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = { role: 'assistant' };
      if (textParts) assistantMsg.content = textParts;
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      result.push(assistantMsg);
    } else {
      // User messages with content blocks — handle tool_result
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          result.push({
            role: 'tool',
            tool_call_id: block.tool_use_id!,
            content: block.content ?? '',
          });
        } else if (block.type === 'text') {
          result.push({ role: 'user', content: block.text ?? '' });
        }
      }
    }
  }

  return result;
}

export class OpenAIProvider implements LLMProvider {
  readonly providerName = 'openai';

  async chat(params: ChatParams): Promise<{ response: ProviderResponse; ttftMs: number }> {
    const client = getClient();

    const openaiMessages = translateMessages(params.system, params.messages);

    const tools: OpenAI.ChatCompletionTool[] | undefined = params.tools?.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    // Stream with TTFT measurement
    const startTime = performance.now();
    let ttftMs = -1;

    const createParams: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools && tools.length > 0) {
      createParams.tools = tools;
    }

    const stream = await client.chat.completions.create(createParams);

    // Accumulate streamed response
    let finishReason = 'unknown';
    let responseId = '';
    let responseModel = params.model;
    let inputTokens = 0;
    let outputTokens = 0;
    const textParts: string[] = [];
    const toolCallAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map();

    for await (const chunk of stream) {
      if (chunk.id) responseId = chunk.id;
      if (chunk.model) responseModel = chunk.model;

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : (choice.finish_reason ?? 'unknown');
      }

      const delta = choice.delta;
      if (delta?.content) {
        if (ttftMs < 0) {
          ttftMs = performance.now() - startTime;
        }
        textParts.push(delta.content);
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallAccumulator.get(tc.index);
          if (existing) {
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          } else {
            toolCallAccumulator.set(tc.index, {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            });
          }
        }
      }
    }

    if (ttftMs < 0) {
      ttftMs = performance.now() - startTime;
    }

    // Build normalized content blocks
    const content: ProviderContentBlock[] = [];
    const text = textParts.join('');
    if (text) {
      content.push({ type: 'text', text });
    }
    for (const [, tc] of toolCallAccumulator) {
      let parsedInput: unknown = {};
      try {
        parsedInput = JSON.parse(tc.arguments);
      } catch { /* leave as empty object */ }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: parsedInput,
      });
    }

    const response: ProviderResponse = {
      id: responseId,
      model: responseModel,
      stopReason: finishReason,
      content,
      usage: { inputTokens, outputTokens },
    };

    return { response, ttftMs };
  }
}
