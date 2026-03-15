import { trace, context, propagation, metrics, SpanStatusCode, Span } from '@opentelemetry/api';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_TOKEN_TYPE_VALUE_INPUT,
  GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
  EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
} from '@opentelemetry/semantic-conventions/incubating';
import { OpenFeature } from '@openfeature/server-sdk';
import type { LLMProvider, ProviderResponse, ProviderContentBlock } from './provider.js';
import { getProvider } from './get-provider.js';

const tracer = trace.getTracer('chatbot');
const meter = metrics.getMeter('chatbot');

const FRONTEND_ADDR = process.env.FRONTEND_ADDR || '';

const featureClient = OpenFeature.getClient();

const ANTHROPIC_RESEARCH_MODELS = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
];

const OPENAI_RESEARCH_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4o',
];

async function getResearchModel(providerName: string): Promise<string> {
  const models = providerName === 'openai' ? OPENAI_RESEARCH_MODELS : ANTHROPIC_RESEARCH_MODELS;
  const roll = Math.random() * 100;
  if (roll < 34) return models[0];
  if (roll < 67) return models[1];
  return models[2];
}

async function getWriterModel(providerName: string): Promise<string> {
  if (providerName === 'openai') {
    return featureClient.getStringValue('chatbot.writer.openai.model', 'gpt-4o-mini');
  }
  return featureClient.getStringValue('chatbot.writer.model', 'claude-haiku-4-5-20251001');
}

// Gen-AI metrics
const tokenUsageCounter = meter.createCounter(METRIC_GEN_AI_CLIENT_TOKEN_USAGE, {
  description: 'Measures number of input and output tokens used',
});
const operationDurationHistogram = meter.createHistogram(METRIC_GEN_AI_CLIENT_OPERATION_DURATION, {
  description: 'GenAI operation duration',
  unit: 's',
});

// Record exception as a span event for debugging visibility
function recordException(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
}

// Format input messages into GenAI semantic convention format
function formatInputMessages(messages: Array<{ role: string; content: string }>): string {
  return JSON.stringify(
    messages.map(m => ({
      role: m.role,
      parts: [{ type: 'text', content: m.content }],
    }))
  );
}

// Format output messages from normalized response into GenAI semantic convention format
function formatOutputMessages(response: { content: ProviderContentBlock[]; stopReason: string }): string {
  return JSON.stringify([
    {
      role: 'assistant',
      parts: response.content.map(b => {
        if (b.type === 'text') {
          return { type: 'text', content: b.text };
        }
        if (b.type === 'tool_use') {
          return { type: 'tool_call', tool_call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) };
        }
        return { type: b.type };
      }),
      finish_reason: response.stopReason,
    },
  ]);
}

// Common metric attributes for gen-ai operations
function metricAttrs(operationName: string, model: string, providerName: string) {
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: operationName,
    [ATTR_GEN_AI_REQUEST_MODEL]: model,
    [ATTR_GEN_AI_PROVIDER_NAME]: providerName,
  };
}

// Record gen-ai metrics after an LLM call
function recordMetrics(
  operationName: string,
  model: string,
  providerName: string,
  usage: { inputTokens: number; outputTokens: number },
  durationMs: number,
): void {
  const attrs = metricAttrs(operationName, model, providerName);
  tokenUsageCounter.add(usage.inputTokens, { ...attrs, [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_INPUT });
  tokenUsageCounter.add(usage.outputTokens, { ...attrs, [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_OUTPUT });
  operationDurationHistogram.record(durationMs / 1000, attrs);
}

// Emit gen-ai inference event on a chat span
function emitInferenceEvent(
  span: Span,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  response: { content: ProviderContentBlock[]; stopReason: string },
): void {
  span.addEvent(EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS, {
    'gen_ai.system_instructions': systemPrompt,
    'gen_ai.input.messages': formatInputMessages(messages),
    'gen_ai.output.messages': formatOutputMessages(response),
  });
}

// Set GenAI semantic attributes on LLM call spans
function setGenAIAttributes(
  span: Span,
  model: string,
  providerName: string,
  systemPrompt: string,
  maxTokens: number,
  response: ProviderResponse,
): void {
  span.setAttribute(ATTR_GEN_AI_PROVIDER_NAME, providerName);
  span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, model);
  span.setAttribute(ATTR_GEN_AI_REQUEST_MAX_TOKENS, maxTokens);
  span.setAttribute(ATTR_GEN_AI_SYSTEM_INSTRUCTIONS, systemPrompt);
  span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, response.model);
  span.setAttribute(ATTR_GEN_AI_RESPONSE_ID, response.id);
  span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [response.stopReason]);
  span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, response.usage.inputTokens);
  span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, response.usage.outputTokens);
  span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, formatOutputMessages(response));
}

function extractText(response: ProviderResponse): string {
  return response.content
    .filter((b): b is ProviderContentBlock & { text: string } => b.type === 'text' && !!b.text)
    .map(b => b.text)
    .join('');
}

const SCOPE_CLASSIFIER_PROMPT = `You are a scope classifier for a customer service chatbot at an online store.
Your ONLY job is to determine if the user's question is about the product catalog, products, or shopping.

Respond with ONLY a JSON object: { "inScope": true } or { "inScope": false }

IN SCOPE: questions about products, prices, descriptions, availability, recommendations, comparisons, or general shopping.
OUT OF SCOPE: anything else (weather, politics, coding, personal advice, etc.)`;

const RESPONSE_GENERATOR_PROMPT = `You are a helpful customer service assistant for an online store.
Answer the customer's question using ONLY the product information provided below.
Be concise and helpful. If the product information doesn't contain enough detail to answer, say so honestly.
Do NOT make up information that isn't in the product data.
Do NOT answer questions unrelated to the products.
Format your response using HTML elements (such as <p>, <ul>, <li>, <strong>) instead of markdown.`;

const PRODUCT_FETCHER_PROMPT = `You are a product data retrieval agent for an online store chatbot.
You have access to a tool called "fetch_products" that retrieves product data from the store's API.
When asked, call the fetch_products tool to get product information. You may optionally pass a product_id to get a specific product.
After receiving the tool result, return the product data as-is without modification.`;

// Sub-agent 1: Scope Classifier
async function classifyScope(question: string, model: string, provider: LLMProvider): Promise<boolean> {
  return tracer.startActiveSpan(`${GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} scope_classifier`, async (agentSpan) => {
    try {
      agentSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
      agentSpan.setAttribute(ATTR_GEN_AI_AGENT_NAME, 'scope_classifier');
      agentSpan.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages([{ role: 'user', content: question }]));

      const result = await tracer.startActiveSpan(`${GEN_AI_OPERATION_NAME_VALUE_CHAT} scope_classifier`, async (span) => {
        try {
          span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_CHAT);
          span.setAttribute('chatbot.question', question);

          const messages = [{ role: 'user' as const, content: question }];
          span.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages(messages));

          const startTime = performance.now();
          const { response, ttftMs } = await provider.chat({
            model,
            maxTokens: 100,
            system: SCOPE_CLASSIFIER_PROMPT,
            messages: [{ role: 'user', content: question }],
          });
          const durationMs = performance.now() - startTime;

          span.setAttribute('app.response.ttft', ttftMs);
          setGenAIAttributes(span, model, provider.providerName, SCOPE_CLASSIFIER_PROMPT, 100, response);
          emitInferenceEvent(span, SCOPE_CLASSIFIER_PROMPT, messages, response);
          recordMetrics(GEN_AI_OPERATION_NAME_VALUE_CHAT, model, provider.providerName, response.usage, durationMs);

          const text = extractText(response);
          let inScope = false;
          try {
            const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
            inScope = JSON.parse(cleaned).inScope === true;
          } catch {
            inScope = false;
          }

          span.setAttribute('chatbot.scope.in_scope', inScope);
          span.setAttribute('chatbot.scope.raw_response', text);
          return inScope;
        } catch (error) {
          recordException(span, error);
          throw error;
        } finally {
          span.end();
        }
      });

      const outputMsg = JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: String(result) }] }]);
      agentSpan.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, outputMsg);
      return result;
    } catch (error) {
      recordException(agentSpan, error);
      throw error;
    } finally {
      agentSpan.end();
    }
  });
}

// Helper: perform the actual HTTP fetch for product data
async function doProductFetch(productId?: string): Promise<string> {
  const baseUrl = FRONTEND_ADDR.startsWith('http')
    ? FRONTEND_ADDR
    : `http://${FRONTEND_ADDR}`;

  const url = productId
    ? `${baseUrl}/api/products/${productId}`
    : `${baseUrl}/api/products`;

  // Inject trace context for propagation to frontend
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);

  const response = await fetch(url, { headers });

  if (!response.ok) {
    return 'Unable to fetch product information.';
  }

  const data = await response.json();
  return JSON.stringify(data, null, 2);
}

// Normalized tool definition for product fetching
const FETCH_PRODUCTS_TOOL = {
  name: 'fetch_products',
  description: 'Fetch product information from the store API. Call with no arguments to get all products, or pass a product_id to get a specific product.',
  parameters: {
    type: 'object' as const,
    properties: {
      product_id: {
        type: 'string',
        description: 'Optional product ID to fetch a specific product',
      },
    },
    required: [] as string[],
  },
};

// Sub-agent 2: Product Fetcher (tool-calling agent)
async function fetchProductInfo(model: string, provider: LLMProvider, productId?: string): Promise<string> {
  return tracer.startActiveSpan(`${GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} product_fetcher`, async (agentSpan) => {
    try {
      agentSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
      agentSpan.setAttribute(ATTR_GEN_AI_AGENT_NAME, 'product_fetcher');
      if (productId) {
        agentSpan.setAttribute('chatbot.product_id', productId);
      }

      const userContent = productId
        ? `Fetch the product with ID: ${productId}`
        : 'Fetch all products from the store.';
      agentSpan.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages([{ role: 'user', content: userContent }]));

      // First chat: ask LLM to call the tool
      const firstResponse = await tracer.startActiveSpan(`${GEN_AI_OPERATION_NAME_VALUE_CHAT} product_fetcher`, async (chatSpan) => {
        try {
          chatSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_CHAT);
          chatSpan.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages([{ role: 'user', content: userContent }]));

          const startTime = performance.now();
          const { response, ttftMs } = await provider.chat({
            model,
            maxTokens: 1024,
            system: PRODUCT_FETCHER_PROMPT,
            tools: [FETCH_PRODUCTS_TOOL],
            messages: [{ role: 'user', content: userContent }],
          });
          const durationMs = performance.now() - startTime;

          chatSpan.setAttribute('app.response.ttft', ttftMs);
          setGenAIAttributes(chatSpan, model, provider.providerName, PRODUCT_FETCHER_PROMPT, 1024, response);
          emitInferenceEvent(chatSpan, PRODUCT_FETCHER_PROMPT, [{ role: 'user', content: userContent }], response);
          recordMetrics(GEN_AI_OPERATION_NAME_VALUE_CHAT, model, provider.providerName, response.usage, durationMs);

          return response;
        } catch (error) {
          recordException(chatSpan, error);
          throw error;
        } finally {
          chatSpan.end();
        }
      });

      // Check if LLM wants to use the tool
      const toolUseBlock = firstResponse.content.find(
        (b) => b.type === 'tool_use'
      ) as (ProviderContentBlock & { type: 'tool_use'; id: string; name: string; input: { product_id?: string } }) | undefined;

      if (!toolUseBlock) {
        // Fallback: LLM didn't call the tool, do a direct fetch
        const fallbackResult = await doProductFetch(productId);
        agentSpan.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: fallbackResult }] }]));
        return fallbackResult;
      }

      // Execute the tool
      const toolResult = await tracer.startActiveSpan(`${GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${toolUseBlock.name}`, async (toolSpan) => {
        try {
          toolSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL);
          toolSpan.setAttribute(ATTR_GEN_AI_TOOL_NAME, toolUseBlock.name);
          toolSpan.setAttribute(ATTR_GEN_AI_TOOL_CALL_ID, toolUseBlock.id);
          toolSpan.setAttribute(ATTR_GEN_AI_TOOL_CALL_ARGUMENTS, JSON.stringify(toolUseBlock.input));

          const fetchId = toolUseBlock.input?.product_id || productId;
          const result = await doProductFetch(fetchId);

          const truncated = result.length > 10000 ? result.substring(0, 10000) + '...(truncated)' : result;
          toolSpan.setAttribute(ATTR_GEN_AI_TOOL_CALL_RESULT, truncated);
          return result;
        } catch (error) {
          recordException(toolSpan, error);
          return 'Unable to fetch product information.';
        } finally {
          toolSpan.end();
        }
      });

      // Second chat: send tool result back to LLM for final response
      const finalText = await tracer.startActiveSpan(`${GEN_AI_OPERATION_NAME_VALUE_CHAT} product_fetcher`, async (chatSpan2) => {
        try {
          chatSpan2.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_CHAT);

          const followUpMessages = [
            { role: 'user' as const, content: userContent },
            {
              role: 'assistant' as const,
              content: firstResponse.content,
            },
            {
              role: 'user' as const,
              content: [
                {
                  type: 'tool_result' as const,
                  tool_use_id: toolUseBlock.id,
                  content: toolResult,
                },
              ],
            },
          ];

          chatSpan2.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, JSON.stringify(followUpMessages.map(m => ({
            role: m.role,
            parts: [{ type: 'text', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
          }))));

          const startTime = performance.now();
          const { response: response2, ttftMs } = await provider.chat({
            model,
            maxTokens: 1024,
            system: PRODUCT_FETCHER_PROMPT,
            tools: [FETCH_PRODUCTS_TOOL],
            messages: followUpMessages,
          });
          const durationMs = performance.now() - startTime;

          chatSpan2.setAttribute('app.response.ttft', ttftMs);
          setGenAIAttributes(chatSpan2, model, provider.providerName, PRODUCT_FETCHER_PROMPT, 1024, response2);
          emitInferenceEvent(chatSpan2, PRODUCT_FETCHER_PROMPT,
            [{ role: 'user', content: typeof followUpMessages[2].content === 'string' ? followUpMessages[2].content : JSON.stringify(followUpMessages[2].content) }],
            response2);
          recordMetrics(GEN_AI_OPERATION_NAME_VALUE_CHAT, model, provider.providerName, response2.usage, durationMs);

          return extractText(response2) || toolResult;
        } catch (error) {
          recordException(chatSpan2, error);
          return toolResult;
        } finally {
          chatSpan2.end();
        }
      });

      agentSpan.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: finalText }] }]));
      return finalText;
    } catch (error) {
      recordException(agentSpan, error);
      return 'Unable to fetch product information.';
    } finally {
      agentSpan.end();
    }
  });
}

// Sub-agent 3: Response Generator
async function generateResponse(question: string, productInfo: string, provider: LLMProvider): Promise<string> {
  const model = await getWriterModel(provider.providerName);
  return tracer.startActiveSpan(`${GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} response_generator`, async (agentSpan) => {
    try {
      agentSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
      agentSpan.setAttribute(ATTR_GEN_AI_AGENT_NAME, 'response_generator');
      agentSpan.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages([{ role: 'user', content: question }]));

      const answer = await tracer.startActiveSpan(`${GEN_AI_OPERATION_NAME_VALUE_CHAT} response_generator`, async (span) => {
        try {
          span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_CHAT);
          span.setAttribute('chatbot.question', question);

          const messages = [{
            role: 'user' as const,
            content: `Product Information:\n${productInfo}\n\nCustomer Question: ${question}`,
          }];
          span.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages(messages));

          const startTime = performance.now();
          const { response, ttftMs } = await provider.chat({
            model,
            maxTokens: 1024,
            system: RESPONSE_GENERATOR_PROMPT,
            messages: [{ role: 'user', content: messages[0].content }],
          });
          const durationMs = performance.now() - startTime;

          span.setAttribute('app.response.ttft', ttftMs);
          setGenAIAttributes(span, model, provider.providerName, RESPONSE_GENERATOR_PROMPT, 1024, response);
          emitInferenceEvent(span, RESPONSE_GENERATOR_PROMPT, messages, response);
          recordMetrics(GEN_AI_OPERATION_NAME_VALUE_CHAT, model, provider.providerName, response.usage, durationMs);

          const text = extractText(response);
          span.setAttribute('chatbot.response_length', text.length);
          return text;
        } catch (error) {
          recordException(span, error);
          throw error;
        } finally {
          span.end();
        }
      });

      agentSpan.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: answer }] }]));
      return answer;
    } catch (error) {
      recordException(agentSpan, error);
      throw error;
    } finally {
      agentSpan.end();
    }
  });
}

export interface HandleQuestionResult {
  answer: string;
  traceId: string;
  spanId: string;
  researchModel: string;
}

// Supervisor agent: orchestrates the sub-agent flow
export async function handleQuestion(question: string, productId?: string): Promise<HandleQuestionResult> {
  return tracer.startActiveSpan('invoke_agent supervisor', async (span) => {
    const { traceId, spanId } = span.spanContext();
    const provider = getProvider();
    const researchModel = await getResearchModel(provider.providerName);
    try {
      span.setAttribute(ATTR_GEN_AI_AGENT_NAME, 'supervisor');
      span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
      span.setAttribute(ATTR_GEN_AI_PROVIDER_NAME, provider.providerName);
      span.setAttribute('chatbot.question', question);
      span.setAttribute('chatbot.research.model', researchModel);
      span.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages([{ role: 'user', content: question }]));
      if (productId) {
        span.setAttribute('chatbot.product_id', productId);
      }

      // Step 1: Classify scope
      const inScope = await classifyScope(question, researchModel, provider);
      if (!inScope) {
        const outOfScopeResponse = "AI Response: Sorry, I'm not able to answer that question.";
        span.setAttribute('chatbot.result', 'out_of_scope');
        span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: outOfScopeResponse }] }]));
        return { answer: outOfScopeResponse, traceId, spanId, researchModel };
      }

      // Step 2: Fetch product information
      const productInfo = await fetchProductInfo(researchModel, provider, productId);

      // Step 3: Generate response
      const answer = await generateResponse(question, productInfo, provider);

      span.setAttribute('chatbot.result', 'success');
      span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: answer }] }]));
      return { answer, traceId, spanId, researchModel };
    } catch (error) {
      console.error('handleQuestion error:', error);
      recordException(span, error);
      const errorResponse = 'The Chatbot is Unavailable';
      span.setAttribute('chatbot.result', 'error');
      span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: errorResponse }] }]));
      return { answer: errorResponse, traceId, spanId, researchModel };
    } finally {
      span.end();
    }
  });
}
