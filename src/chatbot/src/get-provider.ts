import type { LLMProvider } from './provider.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIProvider } from './openai-provider.js';

const anthropicProvider = new AnthropicProvider();
const openaiProvider = new OpenAIProvider();

/**
 * Select a provider for the current request.
 * - If both API keys are set, randomly picks 50/50.
 * - If only one key is set, uses that provider.
 * - Throws if neither key is set.
 */
export function getProvider(): LLMProvider {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;

  if (hasAnthropic && hasOpenAI) {
    return Math.random() < 0.5 ? anthropicProvider : openaiProvider;
  }
  if (hasAnthropic) return anthropicProvider;
  if (hasOpenAI) return openaiProvider;

  throw new Error('No LLM API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
}
