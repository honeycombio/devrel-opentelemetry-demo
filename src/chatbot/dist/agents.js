"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleQuestion = handleQuestion;
const api_1 = require("@opentelemetry/api");
const incubating_1 = require("@opentelemetry/semantic-conventions/incubating");
const server_sdk_1 = require("@openfeature/server-sdk");
const anthropic_client_1 = require("./anthropic-client");
const tracer = api_1.trace.getTracer('chatbot');
const meter = api_1.metrics.getMeter('chatbot');
const FRONTEND_ADDR = process.env.FRONTEND_ADDR || '';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const featureClient = server_sdk_1.OpenFeature.getClient();
async function getResearchModel() {
    return featureClient.getStringValue('chatbot.research.model', DEFAULT_MODEL);
}
async function getWriterModel() {
    return featureClient.getStringValue('chatbot.writer.model', DEFAULT_MODEL);
}
// Gen-AI metrics
const tokenUsageCounter = meter.createCounter(incubating_1.METRIC_GEN_AI_CLIENT_TOKEN_USAGE, {
    description: 'Measures number of input and output tokens used',
});
const operationDurationHistogram = meter.createHistogram(incubating_1.METRIC_GEN_AI_CLIENT_OPERATION_DURATION, {
    description: 'GenAI operation duration',
    unit: 's',
});
// Record exception as a span event for debugging visibility
function recordException(span, error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({ code: api_1.SpanStatusCode.ERROR, message: String(error) });
}
// Format input messages into GenAI semantic convention format
function formatInputMessages(messages) {
    return JSON.stringify(messages.map(m => ({
        role: m.role,
        parts: [{ type: 'text', content: m.content }],
    })));
}
// Format output messages from Anthropic response into GenAI semantic convention format
function formatOutputMessages(response) {
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
            finish_reason: response.stop_reason ?? 'unknown',
        },
    ]);
}
// Common metric attributes for gen-ai operations
function metricAttrs(operationName, model) {
    return {
        [incubating_1.ATTR_GEN_AI_OPERATION_NAME]: operationName,
        [incubating_1.ATTR_GEN_AI_REQUEST_MODEL]: model,
        [incubating_1.ATTR_GEN_AI_PROVIDER_NAME]: incubating_1.GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
    };
}
// Record gen-ai metrics after an LLM call
function recordMetrics(operationName, model, usage, durationMs) {
    const attrs = metricAttrs(operationName, model);
    tokenUsageCounter.add(usage.input_tokens, { ...attrs, [incubating_1.ATTR_GEN_AI_TOKEN_TYPE]: incubating_1.GEN_AI_TOKEN_TYPE_VALUE_INPUT });
    tokenUsageCounter.add(usage.output_tokens, { ...attrs, [incubating_1.ATTR_GEN_AI_TOKEN_TYPE]: incubating_1.GEN_AI_TOKEN_TYPE_VALUE_OUTPUT });
    operationDurationHistogram.record(durationMs / 1000, attrs);
}
// Emit gen-ai inference event on a chat span
function emitInferenceEvent(span, systemPrompt, messages, response) {
    span.addEvent(incubating_1.EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS, {
        'gen_ai.system_instructions': systemPrompt,
        'gen_ai.input.messages': formatInputMessages(messages),
        'gen_ai.output.messages': formatOutputMessages(response),
    });
}
// Set GenAI semantic attributes on LLM call spans
function setGenAIAttributes(span, model, systemPrompt, maxTokens, response) {
    span.setAttribute(incubating_1.ATTR_GEN_AI_PROVIDER_NAME, incubating_1.GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC);
    span.setAttribute(incubating_1.ATTR_GEN_AI_REQUEST_MODEL, model);
    span.setAttribute(incubating_1.ATTR_GEN_AI_REQUEST_MAX_TOKENS, maxTokens);
    span.setAttribute(incubating_1.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS, systemPrompt);
    span.setAttribute(incubating_1.ATTR_GEN_AI_RESPONSE_MODEL, response.model);
    span.setAttribute(incubating_1.ATTR_GEN_AI_RESPONSE_ID, response.id);
    span.setAttribute(incubating_1.ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [response.stop_reason ?? 'unknown']);
    span.setAttribute(incubating_1.ATTR_GEN_AI_USAGE_INPUT_TOKENS, response.usage.input_tokens);
    span.setAttribute(incubating_1.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, response.usage.output_tokens);
    span.setAttribute(incubating_1.ATTR_GEN_AI_OUTPUT_MESSAGES, formatOutputMessages(response));
}
function extractText(response) {
    return response.content
        .filter((b) => b.type === 'text')
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
async function classifyScope(question) {
    const model = await getResearchModel();
    return tracer.startActiveSpan(`${incubating_1.GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} scope_classifier`, async (agentSpan) => {
        try {
            agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_OPERATION_NAME, incubating_1.GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
            agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_AGENT_NAME, 'scope_classifier');
            agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages([{ role: 'user', content: question }]));
            const result = await tracer.startActiveSpan(`${incubating_1.GEN_AI_OPERATION_NAME_VALUE_CHAT} ${model}`, async (span) => {
                try {
                    span.setAttribute(incubating_1.ATTR_GEN_AI_OPERATION_NAME, incubating_1.GEN_AI_OPERATION_NAME_VALUE_CHAT);
                    span.setAttribute('chatbot.question', question);
                    const messages = [{ role: 'user', content: question }];
                    span.setAttribute(incubating_1.ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages(messages));
                    const client = (0, anthropic_client_1.getAnthropicClient)();
                    const startTime = performance.now();
                    const response = await client.messages.create({
                        model,
                        max_tokens: 100,
                        system: SCOPE_CLASSIFIER_PROMPT,
                        messages,
                    });
                    const durationMs = performance.now() - startTime;
                    setGenAIAttributes(span, model, SCOPE_CLASSIFIER_PROMPT, 100, response);
                    emitInferenceEvent(span, SCOPE_CLASSIFIER_PROMPT, messages, response);
                    recordMetrics(incubating_1.GEN_AI_OPERATION_NAME_VALUE_CHAT, model, response.usage, durationMs);
                    const text = extractText(response);
                    let inScope = false;
                    try {
                        const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
                        inScope = JSON.parse(cleaned).inScope === true;
                    }
                    catch {
                        inScope = false;
                    }
                    span.setAttribute('chatbot.scope.in_scope', inScope);
                    span.setAttribute('chatbot.scope.raw_response', text);
                    return inScope;
                }
                catch (error) {
                    recordException(span, error);
                    throw error;
                }
                finally {
                    span.end();
                }
            });
            const outputMsg = JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: String(result) }] }]);
            agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_OUTPUT_MESSAGES, outputMsg);
            return result;
        }
        catch (error) {
            recordException(agentSpan, error);
            throw error;
        }
        finally {
            agentSpan.end();
        }
    });
}
// Helper: perform the actual HTTP fetch for product data
async function doProductFetch(productId) {
    const baseUrl = FRONTEND_ADDR.startsWith('http')
        ? FRONTEND_ADDR
        : `http://${FRONTEND_ADDR}`;
    const url = productId
        ? `${baseUrl}/api/products/${productId}`
        : `${baseUrl}/api/products`;
    // Inject trace context for propagation to frontend
    const headers = {};
    api_1.propagation.inject(api_1.context.active(), headers);
    const response = await fetch(url, { headers });
    if (!response.ok) {
        return 'Unable to fetch product information.';
    }
    const data = await response.json();
    return JSON.stringify(data, null, 2);
}
// Anthropic tool definition for product fetching
const FETCH_PRODUCTS_TOOL = {
    name: 'fetch_products',
    description: 'Fetch product information from the store API. Call with no arguments to get all products, or pass a product_id to get a specific product.',
    input_schema: {
        type: 'object',
        properties: {
            product_id: {
                type: 'string',
                description: 'Optional product ID to fetch a specific product',
            },
        },
        required: [],
    },
};
// Sub-agent 2: Product Fetcher (tool-calling agent)
async function fetchProductInfo(productId) {
    const model = await getResearchModel();
    return tracer.startActiveSpan(`${incubating_1.GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} product_fetcher`, async (agentSpan) => {
        try {
            agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_OPERATION_NAME, incubating_1.GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
            agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_AGENT_NAME, 'product_fetcher');
            if (productId) {
                agentSpan.setAttribute('chatbot.product_id', productId);
            }
            const userContent = productId
                ? `Fetch the product with ID: ${productId}`
                : 'Fetch all products from the store.';
            agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages([{ role: 'user', content: userContent }]));
            const client = (0, anthropic_client_1.getAnthropicClient)();
            const messages = [
                { role: 'user', content: userContent },
            ];
            // First chat: ask Claude to call the tool
            const firstResponse = await tracer.startActiveSpan(`${incubating_1.GEN_AI_OPERATION_NAME_VALUE_CHAT} ${model}`, async (chatSpan) => {
                try {
                    chatSpan.setAttribute(incubating_1.ATTR_GEN_AI_OPERATION_NAME, incubating_1.GEN_AI_OPERATION_NAME_VALUE_CHAT);
                    chatSpan.setAttribute(incubating_1.ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages([{ role: 'user', content: userContent }]));
                    const startTime = performance.now();
                    const response = await client.messages.create({
                        model,
                        max_tokens: 1024,
                        system: PRODUCT_FETCHER_PROMPT,
                        tools: [FETCH_PRODUCTS_TOOL],
                        messages: [{ role: 'user', content: userContent }],
                    });
                    const durationMs = performance.now() - startTime;
                    setGenAIAttributes(chatSpan, model, PRODUCT_FETCHER_PROMPT, 1024, response);
                    emitInferenceEvent(chatSpan, PRODUCT_FETCHER_PROMPT, [{ role: 'user', content: userContent }], response);
                    recordMetrics(incubating_1.GEN_AI_OPERATION_NAME_VALUE_CHAT, model, response.usage, durationMs);
                    return response;
                }
                catch (error) {
                    recordException(chatSpan, error);
                    throw error;
                }
                finally {
                    chatSpan.end();
                }
            });
            // Check if Claude wants to use the tool
            const toolUseBlock = firstResponse.content.find((b) => b.type === 'tool_use');
            if (!toolUseBlock) {
                // Fallback: Claude didn't call the tool, do a direct fetch
                const fallbackResult = await doProductFetch(productId);
                agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: fallbackResult }] }]));
                return fallbackResult;
            }
            // Execute the tool
            const toolResult = await tracer.startActiveSpan(`${incubating_1.GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${toolUseBlock.name}`, async (toolSpan) => {
                try {
                    toolSpan.setAttribute(incubating_1.ATTR_GEN_AI_OPERATION_NAME, incubating_1.GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL);
                    toolSpan.setAttribute(incubating_1.ATTR_GEN_AI_TOOL_NAME, toolUseBlock.name);
                    toolSpan.setAttribute(incubating_1.ATTR_GEN_AI_TOOL_CALL_ID, toolUseBlock.id);
                    toolSpan.setAttribute(incubating_1.ATTR_GEN_AI_TOOL_CALL_ARGUMENTS, JSON.stringify(toolUseBlock.input));
                    const fetchId = toolUseBlock.input?.product_id || productId;
                    const result = await doProductFetch(fetchId);
                    const truncated = result.length > 10000 ? result.substring(0, 10000) + '...(truncated)' : result;
                    toolSpan.setAttribute(incubating_1.ATTR_GEN_AI_TOOL_CALL_RESULT, truncated);
                    return result;
                }
                catch (error) {
                    recordException(toolSpan, error);
                    return 'Unable to fetch product information.';
                }
                finally {
                    toolSpan.end();
                }
            });
            // Second chat: send tool result back to Claude for final response
            const finalText = await tracer.startActiveSpan(`${incubating_1.GEN_AI_OPERATION_NAME_VALUE_CHAT} ${model}`, async (chatSpan2) => {
                try {
                    chatSpan2.setAttribute(incubating_1.ATTR_GEN_AI_OPERATION_NAME, incubating_1.GEN_AI_OPERATION_NAME_VALUE_CHAT);
                    const followUpMessages = [
                        { role: 'user', content: userContent },
                        { role: 'assistant', content: firstResponse.content },
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'tool_result',
                                    tool_use_id: toolUseBlock.id,
                                    content: toolResult,
                                },
                            ],
                        },
                    ];
                    chatSpan2.setAttribute(incubating_1.ATTR_GEN_AI_INPUT_MESSAGES, JSON.stringify(followUpMessages.map(m => ({
                        role: m.role,
                        parts: [{ type: 'text', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
                    }))));
                    const startTime = performance.now();
                    const response2 = await client.messages.create({
                        model,
                        max_tokens: 1024,
                        system: PRODUCT_FETCHER_PROMPT,
                        tools: [FETCH_PRODUCTS_TOOL],
                        messages: followUpMessages,
                    });
                    const durationMs = performance.now() - startTime;
                    setGenAIAttributes(chatSpan2, model, PRODUCT_FETCHER_PROMPT, 1024, response2);
                    emitInferenceEvent(chatSpan2, PRODUCT_FETCHER_PROMPT, [{ role: 'user', content: typeof followUpMessages[2].content === 'string' ? followUpMessages[2].content : JSON.stringify(followUpMessages[2].content) }], response2);
                    recordMetrics(incubating_1.GEN_AI_OPERATION_NAME_VALUE_CHAT, model, response2.usage, durationMs);
                    return extractText(response2) || toolResult;
                }
                catch (error) {
                    recordException(chatSpan2, error);
                    return toolResult;
                }
                finally {
                    chatSpan2.end();
                }
            });
            agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: finalText }] }]));
            return finalText;
        }
        catch (error) {
            recordException(agentSpan, error);
            return 'Unable to fetch product information.';
        }
        finally {
            agentSpan.end();
        }
    });
}
// Sub-agent 3: Response Generator
async function generateResponse(question, productInfo) {
    const model = await getWriterModel();
    return tracer.startActiveSpan(`${incubating_1.GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} response_generator`, async (agentSpan) => {
        try {
            agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_OPERATION_NAME, incubating_1.GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
            agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_AGENT_NAME, 'response_generator');
            agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages([{ role: 'user', content: question }]));
            const answer = await tracer.startActiveSpan(`${incubating_1.GEN_AI_OPERATION_NAME_VALUE_CHAT} ${model}`, async (span) => {
                try {
                    span.setAttribute(incubating_1.ATTR_GEN_AI_OPERATION_NAME, incubating_1.GEN_AI_OPERATION_NAME_VALUE_CHAT);
                    span.setAttribute('chatbot.question', question);
                    const messages = [{
                            role: 'user',
                            content: `Product Information:\n${productInfo}\n\nCustomer Question: ${question}`,
                        }];
                    span.setAttribute(incubating_1.ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages(messages));
                    const client = (0, anthropic_client_1.getAnthropicClient)();
                    const startTime = performance.now();
                    const response = await client.messages.create({
                        model,
                        max_tokens: 1024,
                        system: RESPONSE_GENERATOR_PROMPT,
                        messages,
                    });
                    const durationMs = performance.now() - startTime;
                    setGenAIAttributes(span, model, RESPONSE_GENERATOR_PROMPT, 1024, response);
                    emitInferenceEvent(span, RESPONSE_GENERATOR_PROMPT, messages, response);
                    recordMetrics(incubating_1.GEN_AI_OPERATION_NAME_VALUE_CHAT, model, response.usage, durationMs);
                    const text = extractText(response);
                    span.setAttribute('chatbot.response_length', text.length);
                    return text;
                }
                catch (error) {
                    recordException(span, error);
                    throw error;
                }
                finally {
                    span.end();
                }
            });
            agentSpan.setAttribute(incubating_1.ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: answer }] }]));
            return answer;
        }
        catch (error) {
            recordException(agentSpan, error);
            throw error;
        }
        finally {
            agentSpan.end();
        }
    });
}
// Supervisor agent: orchestrates the sub-agent flow
async function handleQuestion(question, productId) {
    return tracer.startActiveSpan('invoke_agent supervisor', async (span) => {
        const { traceId, spanId } = span.spanContext();
        try {
            span.setAttribute(incubating_1.ATTR_GEN_AI_AGENT_NAME, 'supervisor');
            span.setAttribute(incubating_1.ATTR_GEN_AI_OPERATION_NAME, incubating_1.GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
            span.setAttribute('chatbot.question', question);
            span.setAttribute(incubating_1.ATTR_GEN_AI_INPUT_MESSAGES, formatInputMessages([{ role: 'user', content: question }]));
            if (productId) {
                span.setAttribute('chatbot.product_id', productId);
            }
            // Step 1: Classify scope
            const inScope = await classifyScope(question);
            if (!inScope) {
                const outOfScopeResponse = "AI Response: Sorry, I'm not able to answer that question.";
                span.setAttribute('chatbot.result', 'out_of_scope');
                span.setAttribute(incubating_1.ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: outOfScopeResponse }] }]));
                return { answer: outOfScopeResponse, traceId, spanId };
            }
            // Step 2: Fetch product information
            const productInfo = await fetchProductInfo(productId);
            // Step 3: Generate response
            const answer = await generateResponse(question, productInfo);
            span.setAttribute('chatbot.result', 'success');
            span.setAttribute(incubating_1.ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: answer }] }]));
            return { answer, traceId, spanId };
        }
        catch (error) {
            console.error('handleQuestion error:', error);
            recordException(span, error);
            const errorResponse = 'The Chatbot is Unavailable';
            span.setAttribute('chatbot.result', 'error');
            span.setAttribute(incubating_1.ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: errorResponse }] }]));
            return { answer: errorResponse, traceId, spanId };
        }
        finally {
            span.end();
        }
    });
}
