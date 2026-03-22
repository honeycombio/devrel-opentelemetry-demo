"use strict";
/**
 * Orchestrates eval scorer execution and emits OTel child spans.
 *
 * Each scorer gets its own child span named "chat - Evaluation - <type>"
 * with a gen_ai.evaluation.result span event containing the results.
 * All three evals run in parallel via Promise.all.
 *
 * Unlike the in-process reference implementation, this version creates
 * child spans from a deserialized W3C traceparent (remote parent).
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
 * Parse a W3C traceparent header into traceId and spanId.
 * Format: 00-<traceId>-<spanId>-<traceFlags>
 */
function parseTraceparent(traceparent) {
    const parts = traceparent.split('-');
    if (parts.length !== 4)
        return null;
    return { traceId: parts[1], spanId: parts[2] };
}
/**
 * Run a single eval scorer as a child span of the remote parent.
 */
async function runEvalAsChildSpan(parentCtx, evalName, agentName, scorerFn) {
    return tracer.startActiveSpan(`chat - Evaluation - ${evalName}`, {
        attributes: {
            [incubating_1.ATTR_GEN_AI_OPERATION_NAME]: 'evaluate',
            [ATTR_GEN_AI_EVALUATION_NAME]: evalName,
            'gen_ai.agent.name': agentName,
        },
    }, parentCtx, async (evalSpan) => {
        try {
            const result = await scorerFn();
            evalSpan.addEvent('gen_ai.evaluation.result', {
                [ATTR_GEN_AI_EVALUATION_NAME]: result.name,
                [ATTR_GEN_AI_EVALUATION_SCORE_VALUE]: result.score <= 0 ? 0.01 : result.score >= 1 ? 0.99 : result.score,
                [ATTR_GEN_AI_EVALUATION_SCORE_LABEL]: result.label,
                [ATTR_GEN_AI_EVALUATION_EXPLANATION]: result.explanation,
            });
            evalSpan.setStatus({ code: api_1.SpanStatusCode.OK });
            return result;
        }
        catch (error) {
            console.error(`Evaluation ${evalName} failed:`, error);
            evalSpan.recordException(error instanceof Error ? error : new Error(String(error)));
            evalSpan.setStatus({ code: api_1.SpanStatusCode.ERROR, message: String(error) });
            return null;
        }
        finally {
            evalSpan.end();
        }
    });
}
/**
 * Run bias, hallucination, and relevance evaluations as child spans
 * of the remote parent identified by the traceparent header.
 *
 * @param traceparent - W3C traceparent header (00-traceId-spanId-flags)
 * @param input - The user's input/question
 * @param output - The LLM's response text
 * @param groundingContext - Context for hallucination detection
 * @param agentName - Which agent made the call (e.g. "product_fetcher")
 */
async function evaluateChat(traceparent, input, output, groundingContext, agentName) {
    const parsed = parseTraceparent(traceparent);
    if (!parsed) {
        console.error('Invalid traceparent:', traceparent);
        return;
    }
    const remoteContext = api_1.trace.setSpanContext(api_1.context.active(), {
        traceId: parsed.traceId,
        spanId: parsed.spanId,
        traceFlags: api_1.TraceFlags.SAMPLED,
        isRemote: true,
    });
    await Promise.all([
        runEvalAsChildSpan(remoteContext, 'Bias', agentName, () => (0, bias_js_1.runBias)(input, output)),
        runEvalAsChildSpan(remoteContext, 'Hallucination', agentName, () => (0, hallucination_js_1.runHallucination)(input, output, groundingContext)),
        runEvalAsChildSpan(remoteContext, 'Relevance', agentName, () => (0, relevance_js_1.runRelevance)(input, output)),
    ]);
}
