import type { LLMProvider } from './provider.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { BedrockProvider } from './bedrock-provider.js';

const anthropicProvider = new AnthropicProvider();
const openaiProvider = new OpenAIProvider();
const bedrockProvider = new BedrockProvider();

/**
 * Select a provider for the current request.
 * - Collects all configured providers (Anthropic, OpenAI, Bedrock).
 * - Randomly picks one from the available pool (equal weight).
 * - Bedrock is available when AWS_REGION is set.
 * - Throws if no provider is configured.
 */
export function getProvider(): LLMProvider {
  const providers: LLMProvider[] = [];

  if (process.env.ANTHROPIC_API_KEY) providers.push(anthropicProvider);
  if (process.env.OPENAI_API_KEY) providers.push(openaiProvider);
  if (process.env.AWS_REGION) providers.push(bedrockProvider);

  if (providers.length === 0) {
    throw new Error('No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or AWS_REGION.');
  }

  return providers[Math.floor(Math.random() * providers.length)];
}
