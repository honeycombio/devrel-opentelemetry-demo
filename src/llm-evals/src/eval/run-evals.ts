/**
 * Orchestrates eval scorer execution and emits OTel signals across two traces:
 *
 * 1. Eval trace (owned by llm-evals service):
 *    - Root span: `eval - llm-evals`
 *    - 3 child scorer spans (Bias, Hallucination, Relevance) — these record
 *      the actual scorer work (Bedrock call duration, inputs, success/error)
 *      with a `gen_ai.evaluation.result` event applied on success.
 *
 * 2. Original chatbot trace:
 *    - 3 `gen_ai.evaluation.result` log records, correlated by trace+span
 *      context to the chatbot's chat-completion span. Each log carries the
 *      score, label, explanation, and a back-pointer to the eval trace.
 *
 * The chatbot trace gets observations (logs), not fake child spans — the
 * eval did not happen during the chat span's wall-clock window, so attaching
 * a span there would misrepresent the timeline.
 */

import { type Span, SpanStatusCode, trace, context, TraceFlags } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
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
const logger = logs.getLogger('llm-evals');

interface EvaluatedContext {
  responseModel: string;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number;
  input: string;
  output: string;
}

// Honeycomb's float ingest collapses 0.0 and 1.0 to integers in some paths,
// which trips up HEATMAP / numeric breakdowns. Keep scores strictly inside (0,1).
function clampScore(score: number): number {
  return score <= 0 ? 0.01 : score >= 1 ? 0.99 : score;
}

function applyEvalResultEvent(span: Span, result: EvalResult, evalCtx: EvaluatedContext): void {
  span.addEvent('gen_ai.evaluation.result', {
    [ATTR_GEN_AI_EVALUATION_NAME]: result.name,
    [ATTR_GEN_AI_EVALUATION_SCORE_VALUE]: clampScore(result.score),
    [ATTR_GEN_AI_EVALUATION_SCORE_LABEL]: result.label,
    [ATTR_GEN_AI_EVALUATION_EXPLANATION]: result.explanation,
    'evaluated.model.name': evalCtx.responseModel,
    'evaluated.usage.input_tokens': evalCtx.inputTokens,
    'evaluated.usage.output_tokens': evalCtx.outputTokens,
    'evaluated.response.ttft': evalCtx.ttftMs,
  });
  span.setStatus({ code: SpanStatusCode.OK });
}

function emitEvalResultLog(
  chatbotCtx: ReturnType<typeof context.active>,
  result: EvalResult,
  evalSpanCtx: { traceId: string; spanId: string },
): void {
  logger.emit({
    context: chatbotCtx,
    severityNumber: SeverityNumber.INFO,
    body: result.explanation,
    attributes: {
      'event.name': 'gen_ai.evaluation.result',
      [ATTR_GEN_AI_EVALUATION_NAME]: result.name,
      [ATTR_GEN_AI_EVALUATION_SCORE_VALUE]: clampScore(result.score),
      [ATTR_GEN_AI_EVALUATION_SCORE_LABEL]: result.label,
      [ATTR_GEN_AI_EVALUATION_EXPLANATION]: result.explanation,
      'eval.trace_id': evalSpanCtx.traceId,
      'eval.span_id': evalSpanCtx.spanId,
    },
  });
}

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

async function runEval(
  evalRootCtx: ReturnType<typeof context.active>,
  chatbotCtx: ReturnType<typeof context.active>,
  evalName: string,
  agentName: string,
  evalCtx: EvaluatedContext,
  scorerFn: () => Promise<EvalResult>,
): Promise<EvalResult | null> {
  const evalSpan = tracer.startSpan(
    `chat - Evaluation - ${evalName}`,
    { attributes: evalSpanAttrs(evalName, agentName, evalCtx) },
    evalRootCtx,
  );

  let result: EvalResult | null = null;

  try {
    result = await scorerFn();
    applyEvalResultEvent(evalSpan, result, evalCtx);
    emitEvalResultLog(chatbotCtx, result, evalSpan.spanContext());
  } catch (error) {
    console.error(`Evaluation ${evalName} failed:`, error);
    evalSpan.recordException(error instanceof Error ? error : new Error(String(error)));
    evalSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
  } finally {
    evalSpan.end();
  }

  return result;
}

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

  // Context that ties log records back to the chatbot's chat-completion span
  const chatbotCtx = trace.setSpanContext(context.active(), {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  // Eval trace root, with a SpanLink back to the source chat span for navigation
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
    links: [{
      context: { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true },
      attributes: { 'link.description': 'source chat span' },
    }],
  });
  const evalRootCtx = trace.setSpanContext(context.active(), evalRootSpan.spanContext());

  try {
    await Promise.all([
      runEval(evalRootCtx, chatbotCtx, 'Bias', agentName, evalCtx, () => runBias(input, output)),
      runEval(evalRootCtx, chatbotCtx, 'Hallucination', agentName, evalCtx, () => runHallucination(input, output, groundingContext)),
      runEval(evalRootCtx, chatbotCtx, 'Relevance', agentName, evalCtx, () => runRelevance(input, output)),
    ]);
    evalRootSpan.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    evalRootSpan.recordException(error instanceof Error ? error : new Error(String(error)));
    evalRootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
  } finally {
    evalRootSpan.end();
  }
}
