"use strict";
/**
 * Orchestrates eval scorer execution and emits OTel spans in two traces:
 *
 * 1. Original chatbot trace (via remote parent from traceparent):
 *    3 eval scorer child spans with gen_ai.evaluation.result events
 *    and span links to the eval trace root.
 *
 * 2. New eval trace:
 *    1 root span + 3 eval scorer child spans with the same events.
 *
 * Scorers run once; results are written to both traces.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateChat = evaluateChat;
const api_1 = require("@opentelemetry/api");
const incubating_1 = require("@opentelemetry/semantic-conventions/incubating");
const bias_js_1 = require("./bias.js");
const hallucination_js_1 = require("./hallucination.js");
const relevance_js_1 = require("./relevance.js");
// gen_ai.evaluation.* attributes (from semconv v1.40.0 spec, not yet in the JS package)
const ATTR_GEN_AI_EVALUATION_NAME = 'gen_ai.evaluation.name';
const ATTR_GEN_AI_EVALUATION_SCORE_VALUE = 'gen_ai.evaluation.score.value';
const ATTR_GEN_AI_EVALUATION_SCORE_LABEL = 'gen_ai.evaluation.score.label';
const ATTR_GEN_AI_EVALUATION_EXPLANATION = 'gen_ai.evaluation.explanation';
const tracer = api_1.trace.getTracer('llm-evals');
/**
 * Write eval result attributes and event onto a span.
 */
function applyEvalResult(span, evalName, result, evalCtx) {
    span.addEvent('gen_ai.evaluation.result', {
        [ATTR_GEN_AI_EVALUATION_NAME]: result.name,
        [ATTR_GEN_AI_EVALUATION_SCORE_VALUE]: result.score <= 0 ? 0.01 : result.score >= 1 ? 0.99 : result.score,
        [ATTR_GEN_AI_EVALUATION_SCORE_LABEL]: result.label,
        [ATTR_GEN_AI_EVALUATION_EXPLANATION]: result.explanation,
        'evaluated.model.name': evalCtx.responseModel,
        'evaluated.usage.input_tokens': evalCtx.inputTokens,
        'evaluated.usage.output_tokens': evalCtx.outputTokens,
        'evaluated.response.ttft': evalCtx.ttftMs,
        'evaluated.input': evalCtx.input,
        'evaluated.output': evalCtx.output,
    });
    span.setStatus({ code: api_1.SpanStatusCode.OK });
}
/**
 * Apply error state to a span.
 */
function applyEvalError(span, evalName, error) {
    console.error(`Evaluation ${evalName} failed:`, error);
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({ code: api_1.SpanStatusCode.ERROR, message: String(error) });
}
/**
 * Base attributes for an eval scorer span.
 */
function evalSpanAttrs(evalName, agentName, evalCtx) {
    return {
        [incubating_1.ATTR_GEN_AI_OPERATION_NAME]: 'evaluate',
        [ATTR_GEN_AI_EVALUATION_NAME]: evalName,
        'gen_ai.agent.name': agentName,
        'evaluated.model.name': evalCtx.responseModel,
        'evaluated.usage.input_tokens': evalCtx.inputTokens,
        'evaluated.usage.output_tokens': evalCtx.outputTokens,
        'evaluated.response.ttft': evalCtx.ttftMs,
        'evaluated.input': evalCtx.input,
        'evaluated.output': evalCtx.output,
    };
}
/**
 * Run a single eval scorer once, then write result spans to both traces.
 *
 * @param remoteParentCtx - Context for the original chatbot trace
 * @param evalRootCtx - Context for the new eval trace (under root span)
 * @param evalRootLink - Span link pointing to the eval trace root span
 * @param evalName - Name of the eval (Bias, Hallucination, Relevance)
 * @param agentName - Which agent made the original call
 * @param scorerFn - The scorer function to execute
 */
async function runEvalDual(remoteParentCtx, evalRootCtx, evalRootLink, evalName, agentName, evalCtx, scorerFn) {
    // Start both spans BEFORE the scorer runs so they capture real duration
    const evalTraceSpan = tracer.startSpan(`chat - Evaluation - ${evalName}`, { attributes: evalSpanAttrs(evalName, agentName, evalCtx) }, evalRootCtx);
    const chatbotTraceSpan = tracer.startSpan(`chat - Evaluation - ${evalName}`, {
        attributes: evalSpanAttrs(evalName, agentName, evalCtx),
        links: [evalRootLink],
    }, remoteParentCtx);
    let result = null;
    try {
        result = await scorerFn();
        applyEvalResult(evalTraceSpan, evalName, result, evalCtx);
        applyEvalResult(chatbotTraceSpan, evalName, result, evalCtx);
    }
    catch (error) {
        applyEvalError(evalTraceSpan, evalName, error);
        applyEvalError(chatbotTraceSpan, evalName, error);
    }
    finally {
        evalTraceSpan.end();
        chatbotTraceSpan.end();
    }
    return result;
}
/**
 * Run bias, hallucination, and relevance evaluations.
 * Results are written to both the original chatbot trace and a new eval trace.
 *
 * @param traceId - Trace ID from the chatbot's chat completion span
 * @param spanId - Span ID from the chatbot's chat completion span
 * @param input - The user's input/question
 * @param output - The LLM's response text
 * @param groundingContext - Context for hallucination detection
 * @param agentName - Which agent made the call (e.g. "response_generator")
 */
async function evaluateChat(traceId, spanId, input, output, groundingContext, agentName, responseModel, inputTokens, outputTokens, ttftMs) {
    const evalCtx = { responseModel, inputTokens, outputTokens, ttftMs, input, output };
    // Remote parent context for the original chatbot trace
    const remoteParentCtx = api_1.trace.setSpanContext(api_1.context.active(), {
        traceId,
        spanId,
        traceFlags: api_1.TraceFlags.SAMPLED,
        isRemote: true,
    });
    // New eval trace: create a root span
    const evalRootSpan = tracer.startSpan('eval - llm-evals', {
        attributes: {
            'eval.source_trace_id': traceId,
            'eval.source_span_id': spanId,
            'gen_ai.agent.name': agentName,
            'evaluated.model.name': responseModel,
            'evaluated.usage.input_tokens': inputTokens,
            'evaluated.usage.output_tokens': outputTokens,
            'evaluated.response.ttft': ttftMs,
            'evaluated.input': input,
            'evaluated.output': output,
        },
    });
    const evalRootCtx = api_1.trace.setSpanContext(api_1.context.active(), evalRootSpan.spanContext());
    // Link from chatbot trace spans to the eval root
    const evalRootLink = {
        context: evalRootSpan.spanContext(),
        attributes: { 'link.description': 'eval trace root' },
    };
    try {
        await Promise.all([
            runEvalDual(remoteParentCtx, evalRootCtx, evalRootLink, 'Bias', agentName, evalCtx, () => (0, bias_js_1.runBias)(input, output)),
            runEvalDual(remoteParentCtx, evalRootCtx, evalRootLink, 'Hallucination', agentName, evalCtx, () => (0, hallucination_js_1.runHallucination)(input, output, groundingContext)),
            runEvalDual(remoteParentCtx, evalRootCtx, evalRootLink, 'Relevance', agentName, evalCtx, () => (0, relevance_js_1.runRelevance)(input, output)),
        ]);
        evalRootSpan.setStatus({ code: api_1.SpanStatusCode.OK });
    }
    catch (error) {
        evalRootSpan.recordException(error instanceof Error ? error : new Error(String(error)));
        evalRootSpan.setStatus({ code: api_1.SpanStatusCode.ERROR, message: String(error) });
    }
    finally {
        evalRootSpan.end();
    }
}
