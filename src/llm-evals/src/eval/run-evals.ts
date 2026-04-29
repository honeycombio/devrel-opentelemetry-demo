/**
 * Eval orchestrator with split emission semantics:
 *
 *   - Eval-trace spans (`eval - llm-evals` root + per-scorer children) emit
 *     in real time as each scorer finishes. They show actual Bedrock-call
 *     latency and any scorer-side errors as they happen. These spans CAN
 *     duplicate on a kafka redelivery — that is accepted as the cost of
 *     getting timely scorer-latency observability.
 *
 *   - `gen_ai.evaluation.result` log records on the chatbot trace are
 *     deferred. The orchestrator runs all scorers, returns their results,
 *     and the caller emits the logs only after every span in the kafka
 *     message has finished phase 1 successfully. Combined with the
 *     "throw → no kafka commit → redeliver" pattern, the chatbot-trace
 *     scoring is exactly-once-or-zero per chat span.
 */

import { type Context, type Span, SpanStatusCode, trace, context, TraceFlags } from '@opentelemetry/api';
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

export interface EvaluatedContext {
  responseModel: string;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number;
  input: string;
  output: string;
}

interface ScorerOutcome {
  name: string;
  result: EvalResult;
  scorerSpanContext: { traceId: string; spanId: string };
}

export interface CompletedScorers {
  scorers: ScorerOutcome[];
}

// Honeycomb's float ingest collapses 0.0 and 1.0 to integers in some paths,
// which trips up HEATMAP / numeric breakdowns. Keep scores strictly inside (0,1).
function clampScore(score: number): number {
  return score <= 0 ? 0.01 : score >= 1 ? 0.99 : score;
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
}

async function runScorerWithSpan(
  evalRootCtx: Context,
  evalName: string,
  agentName: string,
  evalCtx: EvaluatedContext,
  scorerFn: () => Promise<EvalResult>,
): Promise<ScorerOutcome> {
  const span = tracer.startSpan(
    `chat - Evaluation - ${evalName}`,
    { attributes: evalSpanAttrs(evalName, agentName, evalCtx) },
    evalRootCtx,
  );
  const scorerSpanContext = {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
  };
  try {
    const result = await scorerFn();
    applyEvalResultEvent(span, result, evalCtx);
    span.setStatus({ code: SpanStatusCode.OK });
    return { name: evalName, result, scorerSpanContext };
  } catch (error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Run all three scorers concurrently. Each scorer's child span (and the
 * `eval - llm-evals` root) is emitted as it completes — including with
 * ERROR status if the scorer threw. Rejects after every scorer has
 * settled so child spans always end before the root.
 */
export async function runEvalScorers(
  traceId: string,
  spanId: string,
  agentName: string,
  evalCtx: EvaluatedContext,
  groundingContext: string,
): Promise<CompletedScorers> {
  const evalRootSpan = tracer.startSpan('eval - llm-evals', {
    attributes: {
      'eval.source_trace_id': traceId,
      'eval.source_span_id': spanId,
      'gen_ai.agent.name': agentName,
      'evaluated.model.name': evalCtx.responseModel,
      'evaluated.usage.input_tokens': evalCtx.inputTokens,
      'evaluated.usage.output_tokens': evalCtx.outputTokens,
      'evaluated.response.ttft': evalCtx.ttftMs,
      'evaluated.input': evalCtx.input,
      'evaluated.output': evalCtx.output,
    },
    links: [{
      context: { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true },
      attributes: { 'link.description': 'source chat span' },
    }],
  });
  const evalRootCtx = trace.setSpanContext(context.active(), evalRootSpan.spanContext());

  // allSettled (not all) so every child span ends cleanly even if one
  // scorer fails early — child end time should precede root end time.
  const settled = await Promise.allSettled([
    runScorerWithSpan(evalRootCtx, 'Bias', agentName, evalCtx,
      () => runBias(evalCtx.input, evalCtx.output)),
    runScorerWithSpan(evalRootCtx, 'Hallucination', agentName, evalCtx,
      () => runHallucination(evalCtx.input, evalCtx.output, groundingContext)),
    runScorerWithSpan(evalRootCtx, 'Relevance', agentName, evalCtx,
      () => runRelevance(evalCtx.input, evalCtx.output)),
  ]);

  const failures = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failures.length > 0) {
    evalRootSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: `${failures.length} of ${settled.length} scorers failed`,
    });
    evalRootSpan.end();
    throw failures[0].reason;
  }
  evalRootSpan.setStatus({ code: SpanStatusCode.OK });
  evalRootSpan.end();

  const scorers = settled.map(
    (s) => (s as PromiseFulfilledResult<ScorerOutcome>).value,
  );
  return { scorers };
}

/**
 * Deferred phase: emit the per-scorer `gen_ai.evaluation.result` log records
 * on the chatbot trace. Called only after every span in a kafka message has
 * succeeded `runEvalScorers`, so a partial-failure case never lands a log
 * on the chatbot trace.
 */
export function emitEvalLogs(
  traceId: string,
  spanId: string,
  completed: CompletedScorers,
): void {
  const chatbotCtx = trace.setSpanContext(context.active(), {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  for (const outcome of completed.scorers) {
    logger.emit({
      context: chatbotCtx,
      severityNumber: SeverityNumber.INFO,
      body: outcome.result.explanation,
      attributes: {
        'event.name': 'gen_ai.evaluation.result',
        [ATTR_GEN_AI_EVALUATION_NAME]: outcome.result.name,
        [ATTR_GEN_AI_EVALUATION_SCORE_VALUE]: clampScore(outcome.result.score),
        [ATTR_GEN_AI_EVALUATION_SCORE_LABEL]: outcome.result.label,
        [ATTR_GEN_AI_EVALUATION_EXPLANATION]: outcome.result.explanation,
        'eval.trace_id': outcome.scorerSpanContext.traceId,
        'eval.span_id': outcome.scorerSpanContext.spanId,
      },
    });
  }
}
