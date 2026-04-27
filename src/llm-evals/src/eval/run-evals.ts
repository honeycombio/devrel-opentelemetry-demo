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

import { type Span, SpanStatusCode, trace, context, TraceFlags, Link } from '@opentelemetry/api';
import {
  ATTR_GEN_AI_OPERATION_NAME,
} from '@opentelemetry/semantic-conventions/incubating';
import { runBias } from './bias.js';
import { runHallucination } from './hallucination.js';
import { runRelevance } from './relevance.js';
import type { EvalResult } from './shared.js';

// gen_ai.evaluation.* attributes (from semconv v1.40.0 spec, not yet in the JS package)
const ATTR_GEN_AI_EVALUATION_NAME = 'gen_ai.evaluation.name';
const ATTR_GEN_AI_EVALUATION_SCORE_VALUE = 'gen_ai.evaluation.score.value';
const ATTR_GEN_AI_EVALUATION_SCORE_LABEL = 'gen_ai.evaluation.score.label';
const ATTR_GEN_AI_EVALUATION_EXPLANATION = 'gen_ai.evaluation.explanation';
const ATTR_GEN_AI_CONVERSATION_ID = 'gen_ai.conversation.id';
// Renamed form used on eval-trace spans so the agentic timeline doesn't pick them up.
// The real gen_ai.conversation.id is only set on spans written back to the original
// (chatbot) trace, which is what asked for the eval.
const ATTR_REQUEST_GEN_AI_CONVERSATION_ID = 'request.gen_ai.conversation.id';

const tracer = trace.getTracer('llm-evals');

interface EvaluatedContext {
  responseModel: string;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number;
  input: string;
  output: string;
  conversationId?: string;
}

/**
 * Write eval result attributes and event onto a span.
 *
 * @param conversationIdAttr - Attribute key for the conversation id. Use
 *   ATTR_GEN_AI_CONVERSATION_ID for spans on the original (chatbot) trace,
 *   ATTR_REQUEST_GEN_AI_CONVERSATION_ID for spans on the eval trace.
 */
function applyEvalResult(
  span: Span,
  evalName: string,
  result: EvalResult,
  evalCtx: EvaluatedContext,
  conversationIdAttr: string,
  mirrorEvalAttrsOnSpan = false,
): void {
  const score = result.score <= 0 ? 0.01 : result.score >= 1 ? 0.99 : result.score;
  const eventAttrs: Record<string, string | number> = {
    [ATTR_GEN_AI_EVALUATION_NAME]: result.name,
    [ATTR_GEN_AI_EVALUATION_SCORE_VALUE]: score,
    [ATTR_GEN_AI_EVALUATION_SCORE_LABEL]: result.label,
    [ATTR_GEN_AI_EVALUATION_EXPLANATION]: result.explanation,
    'evaluated.model.name': evalCtx.responseModel,
    'evaluated.usage.input_tokens': evalCtx.inputTokens,
    'evaluated.usage.output_tokens': evalCtx.outputTokens,
    'evaluated.response.ttft': evalCtx.ttftMs,
    'evaluated.input': evalCtx.input,
    'evaluated.output': evalCtx.output,
  };
  if (evalCtx.conversationId) {
    eventAttrs[conversationIdAttr] = evalCtx.conversationId;
  }
  span.addEvent('gen_ai.evaluation.result', eventAttrs);

  // TEMPORARY:  mirror eval name/label/value/explanation onto the span itself
  // so they show up on the requesting (chatbot) trace. 
  if (mirrorEvalAttrsOnSpan) {
    span.setAttribute(ATTR_GEN_AI_EVALUATION_NAME, result.name);
    span.setAttribute(ATTR_GEN_AI_EVALUATION_SCORE_LABEL, result.label);
    span.setAttribute(ATTR_GEN_AI_EVALUATION_SCORE_VALUE, score);
    span.setAttribute(ATTR_GEN_AI_EVALUATION_EXPLANATION, result.explanation);
  }

  span.setStatus({ code: SpanStatusCode.OK });
}

/**
 * Apply error state to a span.
 */
function applyEvalError(span: Span, evalName: string, error: unknown): void {
  console.error(`Evaluation ${evalName} failed:`, error);
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
}

/**
 * Base attributes for an eval scorer span.
 *
 * @param conversationIdAttr - Attribute key for the conversation id. See applyEvalResult.
 */
function evalSpanAttrs(
  evalName: string,
  agentName: string,
  evalCtx: EvaluatedContext,
  conversationIdAttr: string,
) {
  const attrs: Record<string, string | number> = {
    [ATTR_GEN_AI_OPERATION_NAME]: 'evaluate',
    [ATTR_GEN_AI_EVALUATION_NAME]: evalName,
    'gen_ai.agent.name': agentName,
    'evaluated.model.name': evalCtx.responseModel,
    'evaluated.usage.input_tokens': evalCtx.inputTokens,
    'evaluated.usage.output_tokens': evalCtx.outputTokens,
    'evaluated.response.ttft': evalCtx.ttftMs,
    'evaluated.input': evalCtx.input,
    'evaluated.output': evalCtx.output,
  };
  if (evalCtx.conversationId) {
    attrs[conversationIdAttr] = evalCtx.conversationId;
  }
  return attrs;
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
async function runEvalDual(
  remoteParentCtx: ReturnType<typeof context.active>,
  evalRootCtx: ReturnType<typeof context.active>,
  evalRootLink: Link,
  evalName: string,
  agentName: string,
  evalCtx: EvaluatedContext,
  scorerFn: () => Promise<EvalResult>,
): Promise<EvalResult | null> {
  // Start both spans BEFORE the scorer runs so they capture real duration.
  // Eval-trace spans use request.gen_ai.conversation.id so the agentic timeline
  // doesn't pull them in; chatbot-trace spans get the real gen_ai.conversation.id.
  const evalTraceSpan = tracer.startSpan(
    `chat - Evaluation - ${evalName}`,
    { attributes: evalSpanAttrs(evalName, agentName, evalCtx, ATTR_REQUEST_GEN_AI_CONVERSATION_ID) },
    evalRootCtx,
  );
  const chatbotTraceSpan = tracer.startSpan(
    `chat - Evaluation - ${evalName}`,
    {
      attributes: evalSpanAttrs(evalName, agentName, evalCtx, ATTR_GEN_AI_CONVERSATION_ID),
      links: [evalRootLink],
    },
    remoteParentCtx,
  );

  let result: EvalResult | null = null;

  try {
    result = await scorerFn();
    applyEvalResult(evalTraceSpan, evalName, result, evalCtx, ATTR_REQUEST_GEN_AI_CONVERSATION_ID);
    applyEvalResult(chatbotTraceSpan, evalName, result, evalCtx, ATTR_GEN_AI_CONVERSATION_ID, true);
  } catch (error) {
    applyEvalError(evalTraceSpan, evalName, error);
    applyEvalError(chatbotTraceSpan, evalName, error);
  } finally {
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
export async function evaluateChat(
  traceId: string,
  spanId: string,
  input: string,
  output: string,
  groundingContext: string,
  agentName: string,
  responseModel: string,
  inputTokens: number,
  outputTokens: number,
  ttftMs: number,
  conversationId?: string,
): Promise<void> {
  const evalCtx: EvaluatedContext = { responseModel, inputTokens, outputTokens, ttftMs, input, output, conversationId };

  // Remote parent context for the original chatbot trace
  const remoteParentCtx = trace.setSpanContext(context.active(), {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  // New eval trace: create a root span
  const rootAttrs: Record<string, string | number> = {
    'eval.source_trace_id': traceId,
    'eval.source_span_id': spanId,
    'gen_ai.agent.name': agentName,
    'evaluated.model.name': responseModel,
    'evaluated.usage.input_tokens': inputTokens,
    'evaluated.usage.output_tokens': outputTokens,
    'evaluated.response.ttft': ttftMs,
    'evaluated.input': input,
    'evaluated.output': output,
  };
  if (conversationId) {
    // Eval trace -- use renamed attr so the agentic timeline ignores it.
    rootAttrs[ATTR_REQUEST_GEN_AI_CONVERSATION_ID] = conversationId;
  }
  const evalRootSpan = tracer.startSpan('eval - llm-evals', {
    attributes: rootAttrs,
  });
  const evalRootCtx = trace.setSpanContext(context.active(), evalRootSpan.spanContext());

  // Link from chatbot trace spans to the eval root
  const evalRootLink: Link = {
    context: evalRootSpan.spanContext(),
    attributes: { 'link.description': 'eval trace root' },
  };

  try {
    await Promise.all([
      runEvalDual(remoteParentCtx, evalRootCtx, evalRootLink, 'Bias', agentName, evalCtx, () => runBias(input, output)),
      runEvalDual(remoteParentCtx, evalRootCtx, evalRootLink, 'Hallucination', agentName, evalCtx, () => runHallucination(input, output, groundingContext)),
      runEvalDual(remoteParentCtx, evalRootCtx, evalRootLink, 'Relevance', agentName, evalCtx, () => runRelevance(input, output)),
    ]);
    evalRootSpan.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    evalRootSpan.recordException(error instanceof Error ? error : new Error(String(error)));
    evalRootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
  } finally {
    evalRootSpan.end();
  }
}
