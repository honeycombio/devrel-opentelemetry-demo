"use strict";
/**
 * Shared types and Bedrock adapter for LLM evaluation scorers.
 *
 * The autoevals library accepts an optional `client` parameter implementing
 * the OpenAI chat.completions.create interface. We provide a minimal Bedrock
 * adapter so the same autoevals prompts run against Claude Haiku on Bedrock.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVAL_MODEL = exports.bedrockAdapter = void 0;
const client_bedrock_runtime_1 = require("@aws-sdk/client-bedrock-runtime");
const bedrockClient = new client_bedrock_runtime_1.BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const HAIKU_ARN = process.env.BEDROCK_HAIKU_PROFILE_ARN;
/**
 * Minimal OpenAI-compatible adapter backed by Bedrock Converse API.
 * autoevals calls client.chat.completions.create({ messages, model, ... })
 * and expects { choices: [{ message: { content } }], usage: { ... } }.
 */
exports.bedrockAdapter = {
    chat: {
        completions: {
            create: async ({ messages }) => {
                const system = messages
                    .filter((m) => m.role === 'system')
                    .map((m) => ({ text: m.content }));
                const convoMessages = messages
                    .filter((m) => m.role !== 'system')
                    .map((m) => ({
                    role: m.role,
                    content: [{ text: m.content }],
                }));
                const response = await bedrockClient.send(new client_bedrock_runtime_1.ConverseCommand({
                    modelId: HAIKU_ARN,
                    ...(system.length > 0 ? { system } : {}),
                    messages: convoMessages,
                }));
                const text = response.output?.message?.content?.[0]?.text ?? '';
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
}; // typed as any to satisfy autoevals' OpenAI Client type
// Intercept autoevals' internal OpenAI client creation via the Braintrust global hook.
// autoevals calls buildOpenAIClient() → checks globalThis.__inherited_braintrust_wrap_openai
// → if set, calls it with the created client and returns the result.
// We ignore the created client and return our Bedrock adapter instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
globalThis.__inherited_braintrust_wrap_openai = () => exports.bedrockAdapter;
exports.EVAL_MODEL = 'bedrock-haiku'; // informational — adapter ignores model param
