import { trace, context, propagation, SpanStatusCode, Span } from '@opentelemetry/api';
import { getAnthropicClient } from './anthropic-client';

const tracer = trace.getTracer('chatbot');

const FRONTEND_ADDR = process.env.FRONTEND_ADDR || '';
const MODEL = 'claude-haiku-4-5-20251001';

// Record exception as a span event for debugging visibility
function recordException(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
}

// Set GenAI semantic attributes on LLM call spans
function setGenAIAttributes(
  span: Span,
  response: { model: string; usage: { input_tokens: number; output_tokens: number } },
): void {
  span.setAttribute('gen_ai.system', 'anthropic');
  span.setAttribute('gen_ai.request.model', MODEL);
  span.setAttribute('gen_ai.response.model', response.model);
  span.setAttribute('gen_ai.usage.input_tokens', response.usage.input_tokens);
  span.setAttribute('gen_ai.usage.output_tokens', response.usage.output_tokens);
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
Do NOT answer questions unrelated to the products.`;

function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

// Sub-agent 1: Scope Classifier
async function classifyScope(question: string): Promise<boolean> {
  return tracer.startActiveSpan('scope_classifier', async (span) => {
    try {
      span.setAttribute('chatbot.agent', 'scope_classifier');
      span.setAttribute('chatbot.question', question);

      const client = getAnthropicClient();
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 100,
        system: SCOPE_CLASSIFIER_PROMPT,
        messages: [{ role: 'user', content: question }],
      });

      setGenAIAttributes(span, response);
      const text = extractText(response);
      let inScope = false;
      try {
        inScope = JSON.parse(text).inScope === true;
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
      span.setAttribute('chatbot.agent', 'product_fetcher');
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
  return tracer.startActiveSpan('response_generator', async (span) => {
    try {
      span.setAttribute('chatbot.agent', 'response_generator');
      span.setAttribute('chatbot.question', question);

      const client = getAnthropicClient();
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: RESPONSE_GENERATOR_PROMPT,
        messages: [{
          role: 'user',
          content: `Product Information:\n${productInfo}\n\nCustomer Question: ${question}`,
        }],
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

// Supervisor agent: orchestrates the sub-agent flow
export async function handleQuestion(question: string, productId?: string): Promise<string> {
  return tracer.startActiveSpan('supervisor', async (span) => {
    try {
      span.setAttribute('chatbot.agent', 'supervisor');
      span.setAttribute('chatbot.question', question);
      if (productId) {
        span.setAttribute('chatbot.product_id', productId);
      }

      // Step 1: Classify scope
      const inScope = await classifyScope(question);
      if (!inScope) {
        span.setAttribute('chatbot.result', 'out_of_scope');
        return "AI Response: Sorry, I'm not able to answer that question.";
      }

      // Step 2: Fetch product information
      const productInfo = await fetchProductInfo(productId);

      // Step 3: Generate response
      const answer = await generateResponse(question, productInfo);

      span.setAttribute('chatbot.result', 'success');
      return answer;
    } catch (error) {
      recordException(span, error);
      span.setAttribute('chatbot.result', 'error');
      return 'The Chatbot is Unavailable';
    } finally {
      span.end();
    }
  });
}
