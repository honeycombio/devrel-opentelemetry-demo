import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  Message as BedrockMessage,
  ContentBlock,
  Tool,
  ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  LLMProvider,
  ChatParams,
  ProviderResponse,
  ProviderContentBlock,
  ProviderMessage,
} from './provider.js';

let _client: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!_client) {
    _client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
  }
  return _client;
}

function translateMessages(messages: ProviderMessage[]): BedrockMessage[] {
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: [{ text: msg.content }] };
    }

    const content: ContentBlock[] = msg.content.map(block => {
      if (block.type === 'text') {
        return { text: block.text ?? '' } as ContentBlock;
      }
      if (block.type === 'tool_use') {
        return {
          toolUse: {
            toolUseId: block.id!,
            name: block.name!,
            input: block.input as Record<string, unknown>,
          },
        } as ContentBlock;
      }
      if (block.type === 'tool_result') {
        const resultContent: ToolResultContentBlock[] = [{ text: block.content ?? '' } as ToolResultContentBlock];
        return {
          toolResult: {
            toolUseId: block.tool_use_id!,
            content: resultContent,
          },
        } as ContentBlock;
      }
      return { text: '' } as ContentBlock;
    });

    return { role: msg.role, content };
  });
}

function translateTools(tools: ChatParams['tools']): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.parameters },
    },
  } as Tool));
}

export class BedrockProvider implements LLMProvider {
  readonly providerName = 'bedrock';

  async chat(params: ChatParams): Promise<{ response: ProviderResponse; ttftMs: number }> {
    const client = getClient();

    const bedrockTools = translateTools(params.tools);
    const bedrockMessages = translateMessages(params.messages);

    const command = new ConverseStreamCommand({
      modelId: params.model,
      messages: bedrockMessages,
      system: [{ text: params.system }],
      inferenceConfig: { maxTokens: params.maxTokens },
      ...(bedrockTools ? { toolConfig: { tools: bedrockTools } } : {}),
    });

    const startTime = performance.now();
    let ttftMs = -1;
    const result = await client.send(command);

    // Accumulate stream
    let stopReason = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;
    const textParts: string[] = [];
    const toolUseBlocks: Map<number, { toolUseId: string; name: string; inputJson: string }> = new Map();
    let currentBlockIndex = -1;

    for await (const event of result.stream!) {
      if ('contentBlockStart' in event && event.contentBlockStart) {
        const { contentBlockIndex, start } = event.contentBlockStart;
        currentBlockIndex = contentBlockIndex ?? -1;
        if (start?.toolUse) {
          toolUseBlocks.set(currentBlockIndex, {
            toolUseId: start.toolUse.toolUseId ?? '',
            name: start.toolUse.name ?? '',
            inputJson: '',
          });
        }
      } else if ('contentBlockDelta' in event && event.contentBlockDelta) {
        const { delta } = event.contentBlockDelta;
        if (delta?.text) {
          if (ttftMs < 0) ttftMs = performance.now() - startTime;
          textParts.push(delta.text);
        }
        if (delta?.toolUse?.input) {
          const block = toolUseBlocks.get(currentBlockIndex);
          if (block) block.inputJson += delta.toolUse.input;
        }
      } else if ('messageStop' in event && event.messageStop) {
        stopReason = event.messageStop.stopReason ?? 'end_turn';
        // normalize bedrock stop reasons to match anthropic/openai conventions
        if (stopReason === 'tool_use') stopReason = 'tool_use';
        else if (stopReason === 'end_turn') stopReason = 'end_turn';
      } else if ('metadata' in event && event.metadata) {
        inputTokens = event.metadata.usage?.inputTokens ?? 0;
        outputTokens = event.metadata.usage?.outputTokens ?? 0;
      }
    }

    if (ttftMs < 0) ttftMs = performance.now() - startTime;

    // Build normalized content blocks
    const content: ProviderContentBlock[] = [];
    const text = textParts.join('');
    if (text) content.push({ type: 'text', text });

    for (const [, block] of toolUseBlocks) {
      let input: unknown = {};
      try { input = JSON.parse(block.inputJson); } catch { /* leave empty */ }
      content.push({ type: 'tool_use', id: block.toolUseId, name: block.name, input });
    }

    const response: ProviderResponse = {
      id: crypto.randomUUID(),
      model: params.model,
      stopReason,
      content,
      usage: { inputTokens, outputTokens },
    };

    return { response, ttftMs };
  }
}
