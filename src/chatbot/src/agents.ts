import { trace, context, propagation, SpanStatusCode, Span } from '@opentelemetry/api';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
} from '@opentelemetry/semantic-conventions/incubating';
import { getAnthropicClient } from './anthropic-client';

const tracer = trace.getTracer('chatbot');

const FRONTEND_ADDR = process.env.FRONTEND_ADDR || '';
const MODEL = 'claude-haiku-4-5-20251001';

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

// Format output messages from Anthropic response into GenAI semantic convention format
function formatOutputMessages(
  response: { content: Array<{ type: string; text?: string }>; stop_reason: string | null }
): string {
  return JSON.stringify([
    {
      role: 'assistant',
      parts: response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => ({ type: 'text', content: b.text })),
      finish_reason: response.stop_reason ?? 'unknown',
    },
  ]);
}

// Set GenAI semantic attributes on LLM call spans
function setGenAIAttributes(
  span: Span,
  response: {
    id: string;
    model: string;
    stop_reason: string | null;
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  },
): void {
  span.setAttribute(ATTR_GEN_AI_PROVIDER_NAME, GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC);
  span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, MODEL);
  span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, response.model);
  span.setAttribute(ATTR_GEN_AI_RESPONSE_ID, response.id);
  span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [response.stop_reason ?? 'unknown']);
  span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, response.usage.input_tokens);
  span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, response.usage.output_tokens);
  span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, formatOutputMessages(response));
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

function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

// Sub-agent 1: Scope Classifier
async function classifyScope(question: string): Promise<boolean> {
  return tracer.startActiveSpan(`${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${MODEL}`, async (span) => {
    try {
      span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_CHAT);
      span.setAttribute(ATTR_GEN_AI_AGENT_NAME, 'scope_classifier');
      span.setAttribute('chatbot.question', question);

      const messages = [{ role: 'user' as const, content: question }];
      span.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages(messages));

      const client = getAnthropicClient();
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 100,
        system: SCOPE_CLASSIFIER_PROMPT,
        messages,
      });

      setGenAIAttributes(span, response);
      const text = extractText(response);
      let inScope = false;
      try {
        const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
        inScope = JSON.parse(cleaned).inScope === true;
      } catch {
        // Parse failure → treat as out of scope
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
}

// Sub-agent 2: Product Fetcher
async function fetchProductInfo(productId?: string): Promise<string> {
  return tracer.startActiveSpan('product_fetcher', async (span) => {
    try {
      span.setAttribute(ATTR_GEN_AI_AGENT_NAME, 'product_fetcher');
      if (productId) {
        span.setAttribute('chatbot.product_id', productId);
      }

      const baseUrl = FRONTEND_ADDR.startsWith('http')
        ? FRONTEND_ADDR
        : `http://${FRONTEND_ADDR}`;

      const url = productId
        ? `${baseUrl}/api/products/${productId}`
        : `${baseUrl}/api/products`;

      // Inject trace context for propagation to frontend
      const headers: Record<string, string> = {};
      propagation.inject(context.active(), headers);

      span.setAttribute('chatbot.product_fetch.url', url);
      const response = await fetch(url, { headers });

      span.setAttribute('chatbot.product_fetch.status', response.status);
      if (!response.ok) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `Product fetch returned ${response.status}` });
        return 'Unable to fetch product information.';
      }

      const data = await response.json();
      const productJson = JSON.stringify(data, null, 2);
      span.setAttribute('chatbot.product_fetch.result_length', productJson.length);
      return productJson;
    } catch (error) {
      recordException(span, error);
      return 'Unable to fetch product information.';
    } finally {
      span.end();
    }
  });
}

// Sub-agent 3: Response Generator
async function generateResponse(question: string, productInfo: string): Promise<string> {
  return tracer.startActiveSpan(`${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${MODEL}`, async (span) => {
    try {
      span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_CHAT);
      span.setAttribute(ATTR_GEN_AI_AGENT_NAME, 'response_generator');
      span.setAttribute('chatbot.question', question);

      const messages = [{
        role: 'user' as const,
        content: `Product Information:\n${productInfo}\n\nCustomer Question: ${question}`,
      }];
      span.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages(messages));

      const client = getAnthropicClient();
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: RESPONSE_GENERATOR_PROMPT,
        messages,
      });

      setGenAIAttributes(span, response);
      const answer = extractText(response);
      span.setAttribute('chatbot.response_length', answer.length);
      return answer;
    } catch (error) {
      recordException(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

export interface HandleQuestionResult {
  answer: string;
  traceId: string;
  spanId: string;
}

// Supervisor agent: orchestrates the sub-agent flow
export async function handleQuestion(question: string, productId?: string): Promise<HandleQuestionResult> {
  return tracer.startActiveSpan('invoke_agent supervisor', async (span) => {
    const { traceId, spanId } = span.spanContext();
    try {
      span.setAttribute(ATTR_GEN_AI_AGENT_NAME, 'supervisor');
      span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
      span.setAttribute('chatbot.question', question);
      span.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages([{ role: 'user', content: question }]));
      if (productId) {
        span.setAttribute('chatbot.product_id', productId);
      }

      // Step 1: Classify scope
      const inScope = await classifyScope(question);
      if (!inScope) {
        const outOfScopeResponse = "AI Response: Sorry, I'm not able to answer that question.";
        span.setAttribute('chatbot.result', 'out_of_scope');
        span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: outOfScopeResponse }] }]));
        return { answer: outOfScopeResponse, traceId, spanId };
      }

      // Step 2: Fetch product information
      const productInfo = await fetchProductInfo(productId);

      // Step 3: Generate response
      const answer = await generateResponse(question, productInfo);

      span.setAttribute('chatbot.result', 'success');
      span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: answer }] }]));
      return { answer, traceId, spanId };
    } catch (error) {
      recordException(span, error);
      const errorResponse = 'The Chatbot is Unavailable';
      span.setAttribute('chatbot.result', 'error');
      span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: errorResponse }] }]));
      return { answer: errorResponse, traceId, spanId };
    } finally {
      span.end();
    }
  });
}
