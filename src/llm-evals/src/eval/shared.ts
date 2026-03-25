/**
 * Shared types and Bedrock adapter for LLM evaluation scorers.
 *
 * The autoevals library accepts an optional `client` parameter implementing
 * the OpenAI chat.completions.create interface. We provide a minimal Bedrock
 * adapter so the same autoevals prompts run against Claude Haiku on Bedrock.
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const HAIKU_ARN = process.env.BEDROCK_HAIKU_PROFILE_ARN!;

// OpenAI tool schema types (subset used by autoevals)
interface OpenAITool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

/**
 * Minimal OpenAI-compatible adapter backed by Bedrock Converse API.
 * autoevals calls client.chat.completions.create({ messages, tools, tool_choice, ... })
 * and expects { choices: [{ message: { tool_calls: [...] } }], usage: { ... } }.
 * We translate OpenAI tool schemas → Bedrock toolConfig, and translate
 * Bedrock tool use blocks back into the OpenAI tool_calls format.
 */
export const bedrockAdapter = {
  chat: {
    completions: {
      create: async ({ messages, tools }: {
        messages: Array<{ role: string; content: string }>;
        tools?: OpenAITool[];
      }) => {
        const system = messages
          .filter((m) => m.role === 'system')
          .map((m) => ({ text: m.content }));
        const convoMessages = messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: [{ text: m.content }],
          }));

        // Translate OpenAI tools → Bedrock toolConfig
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolConfig: any = tools && tools.length > 0 ? {
          tools: tools.map((t) => ({
            toolSpec: {
              name: t.function.name,
              description: t.function.description ?? '',
              inputSchema: { json: t.function.parameters ?? {} },
            },
          })),
          toolChoice: { any: {} }, // force tool use
        } : undefined;

        const response = await bedrockClient.send(
          new ConverseCommand({
            modelId: HAIKU_ARN,
            ...(system.length > 0 ? { system } : {}),
            messages: convoMessages,
            ...(toolConfig ? { toolConfig } : {}),
          }),
        );

        const contentBlocks = response.output?.message?.content ?? [];

        // If Bedrock returned tool use blocks, translate to OpenAI tool_calls format
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolUseBlocks = contentBlocks.filter((b: any) => b.toolUse);
        if (toolUseBlocks.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tool_calls = toolUseBlocks.map((b: any) => ({
            id: b.toolUse.toolUseId,
            type: 'function',
            function: {
              name: b.toolUse.name,
              arguments: JSON.stringify(b.toolUse.input),
            },
          }));
          return {
            choices: [{ message: { role: 'assistant', content: null, tool_calls }, finish_reason: 'tool_calls' }],
            usage: {
              prompt_tokens: response.usage?.inputTokens ?? 0,
              completion_tokens: response.usage?.outputTokens ?? 0,
              total_tokens: (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
            },
          };
        }

        // Plain text response fallback
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = contentBlocks.find((b: any) => b.text)?.text ?? '';
        return {
          choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: response.usage?.inputTokens ?? 0,
            completion_tokens: response.usage?.outputTokens ?? 0,
            total_tokens: (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
          },
        };
      },
    },
  },
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any; // typed as any to satisfy autoevals' OpenAI Client type

// autoevals calls `new OpenAI({ apiKey: ... })` before checking the hook, so the
// constructor throws if OPENAI_API_KEY is unset. Provide a dummy value so the
// constructor succeeds; the hook below then replaces the client with our Bedrock adapter.
if (!process.env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = 'bedrock-via-braintrust-hook';
}

// Intercept autoevals' internal OpenAI client creation via the Braintrust global hook.
// autoevals calls buildOpenAIClient() → checks globalThis.__inherited_braintrust_wrap_openai
// → if set, calls it with the created client and returns the result.
// We ignore the created client and return our Bedrock adapter instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__inherited_braintrust_wrap_openai = () => bedrockAdapter;

export const EVAL_MODEL = 'bedrock-haiku'; // informational — adapter ignores model param

export interface EvalResult {
  name: string;
  score: number;
  label: string;
  explanation: string;
}
