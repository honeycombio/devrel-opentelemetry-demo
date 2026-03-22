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

const tracer = trace.getTracer('llm-evals');

interface EvaluatedContext {
  responseModel: string;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number;
  input: string;
  output: string;
}

/**
 * Write eval result attributes and event onto a span.
 */
function applyEvalResult(span: Span, evalName: string, result: EvalResult, evalCtx: EvaluatedContext): void {
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
 */
function evalSpanAttrs(evalName: string, agentName: string, evalCtx: EvaluatedContext) {
  return {
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
  // Start both spans BEFORE the scorer runs so they capture real duration
  const evalTraceSpan = tracer.startSpan(
    `chat - Evaluation - ${evalName}`,
    { attributes: evalSpanAttrs(evalName, agentName, evalCtx) },
    evalRootCtx,
  );
  const chatbotTraceSpan = tracer.startSpan(
    `chat - Evaluation - ${evalName}`,
    {
      attributes: evalSpanAttrs(evalName, agentName, evalCtx),
      links: [evalRootLink],
    },
    remoteParentCtx,
  );

  let result: EvalResult | null = null;

  try {
    result = await scorerFn();
    applyEvalResult(evalTraceSpan, evalName, result, evalCtx);
    applyEvalResult(chatbotTraceSpan, evalName, result, evalCtx);
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
): Promise<void> {
  const evalCtx: EvaluatedContext = { responseModel, inputTokens, outputTokens, ttftMs, input, output };

  // Remote parent context for the original chatbot trace
  const remoteParentCtx = trace.setSpanContext(context.active(), {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
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
