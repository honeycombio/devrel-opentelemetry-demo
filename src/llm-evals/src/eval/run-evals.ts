/**
 * Orchestrates eval scorer execution and emits OTel telemetry in two places:
 *
 * 1. Original chatbot trace (via remote SpanContext from traceId/spanId):
 *    one OTel LogRecord per eval result, timestamped at the requesting span's
 *    end so it lands inside that span on the trace timeline. No spans are
 *    created on the chatbot trace.
 *
 * 2. New eval trace:
 *    1 root span + 3 eval scorer child spans. These are the source of truth
 *    for the eval execution itself.
 *
 * Scorers run once; results are written to both places.
 */

import { type Span, SpanStatusCode, trace, context, TraceFlags } from '@opentelemetry/api';
import { type Logger, SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import {
  ATTR_EVENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
} from '@opentelemetry/semantic-conventions/incubating';
import { runBias } from './bias.js';
import { runHallucination } from './hallucination.js';
import { runRelevance } from './relevance.js';
import type { EvalResult } from './shared.js';

// gen_ai.evaluation.* attributes (from semconv v1.40.0 spec, not yet in the JS package)
const ATTR_GEN_AI_EVENT_NAME = 'event.name';
const ATTR_GEN_AI_EVALUATION_NAME = 'gen_ai.evaluation.name';
const ATTR_GEN_AI_EVALUATION_SCORE_VALUE = 'gen_ai.evaluation.score.value';
const ATTR_GEN_AI_EVALUATION_SCORE_LABEL = 'gen_ai.evaluation.score.label';
const ATTR_GEN_AI_EVALUATION_EXPLANATION = 'gen_ai.evaluation.explanation';
const ATTR_GEN_AI_CONVERSATION_ID = 'gen_ai.conversation.id';
// Renamed form used on eval-trace spans so the agentic timeline doesn't pick them up.
// The real gen_ai.conversation.id is only set on log records written to the original
// (chatbot) trace, which is what asked for the eval.
const ATTR_REQUEST_GEN_AI_CONVERSATION_ID = 'request.gen_ai.conversation.id';

const tracer = trace.getTracer('llm-evals');

/**
 * Cache of per-source-service Loggers backed by their own LoggerProvider so
 * eval log records carry `service.name` of the service whose trace they
 * correlate to (e.g., store-chat) rather than llm-evals. This makes
 * Honeycomb's GenAI panel scope to the same service as the evaluated span.
 *
 * Trade-off: the eval log record's resource attrs (host.*, k8s.*) will be
 * empty rather than describing the llm-evals pod. Acceptable — those attrs
 * would be misleading anyway since the record claims to be from store-chat.
 */
const loggersBySourceService = new Map<string, Logger>();

function loggerForSourceService(sourceService: string): Logger {
  let logger = loggersBySourceService.get(sourceService);
  if (!logger) {
    const provider = new LoggerProvider({
      resource: resourceFromAttributes({ 'service.name': sourceService }),
      processors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
    });
    logger = provider.getLogger('llm-evals');
    loggersBySourceService.set(sourceService, logger);
  }
  return logger;
}

interface EvaluatedContext {
  responseModel: string;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number;
  input: string;
  output: string;
  conversationId?: string;
}

function clampScore(score: number): number {
  return score <= 0 ? 0.01 : score >= 1 ? 0.99 : score;
}

function evalResultAttributes(
  result: EvalResult,
  evalCtx: EvaluatedContext,
  conversationIdAttr: string,
): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    [ATTR_GEN_AI_EVALUATION_NAME]: result.name,
    [ATTR_GEN_AI_EVALUATION_SCORE_VALUE]: clampScore(result.score),
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
    attrs[conversationIdAttr] = evalCtx.conversationId;
  }
  return attrs;
}

/**
 * Emit a LogRecord on the chatbot trace at the requesting span's end time.
 *
 * The log record correlates to the chatbot's span via explicit SpanContext on
 * its associated OTel context, and is positioned on the trace timeline at
 * `requestedAtMs` so Honeycomb's trace view shows it inside that span.
 */
function emitChatbotTraceLog(
  traceId: string,
  spanId: string,
  requestedAtMs: number | undefined,
  sourceService: string,
  evalName: string,
  result: EvalResult,
  evalCtx: EvaluatedContext,
): void {
  const remoteParentCtx = trace.setSpanContext(context.active(), {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
  loggerForSourceService(sourceService).emit({
    timestamp: requestedAtMs ?? Date.now(),
    severityNumber: SeverityNumber.INFO,
    body: 'gen_ai.evaluation.result',
    eventName: 'gen_ai.evaluation.result',
    attributes: evalResultAttributes(result, evalCtx, ATTR_GEN_AI_CONVERSATION_ID),
    context: remoteParentCtx,
  });
}

function applyEvalResultToSpan(
  span: Span,
  result: EvalResult,
  evalCtx: EvaluatedContext,
  conversationIdAttr: string,
): void {
  const attrs = evalResultAttributes(result, evalCtx, conversationIdAttr);
  span.addEvent('gen_ai.evaluation.result', attrs);
  span.setStatus({ code: SpanStatusCode.OK });
}

function applyEvalError(span: Span, evalName: string, error: unknown): void {
  console.error(`Evaluation ${evalName} failed:`, error);
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
}

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
 * Run a single eval scorer once, write a span on the eval trace, and emit a
 * log record on the chatbot trace.
 */
async function runEvalDual(
  evalRootCtx: ReturnType<typeof context.active>,
  traceId: string,
  spanId: string,
  requestedAtMs: number | undefined,
  sourceService: string,
  evalName: string,
  agentName: string,
  evalCtx: EvaluatedContext,
  scorerFn: () => Promise<EvalResult>,
): Promise<EvalResult | null> {
  const evalTraceSpan = tracer.startSpan(
    `chat - Evaluation - ${evalName}`,
    { attributes: evalSpanAttrs(evalName, agentName, evalCtx, ATTR_REQUEST_GEN_AI_CONVERSATION_ID) },
    evalRootCtx,
  );

  let result: EvalResult | null = null;

  try {
    result = await scorerFn();
    applyEvalResultToSpan(evalTraceSpan, result, evalCtx, ATTR_REQUEST_GEN_AI_CONVERSATION_ID);
    emitChatbotTraceLog(traceId, spanId, requestedAtMs, sourceService, evalName, result, evalCtx);
  } catch (error) {
    applyEvalError(evalTraceSpan, evalName, error);
  } finally {
    evalTraceSpan.end();
  }

  return result;
}

/**
 * Run bias, hallucination, and relevance evaluations.
 * Results are written to a new eval trace (spans) and the original chatbot
 * trace (one log record per eval, anchored to the requesting span).
 *
 * @param traceId - Trace ID from the chatbot's requesting span
 * @param spanId - Span ID from the chatbot's requesting span (e.g., supervisor invoke_agent)
 * @param requestedAtMs - Epoch-ms timestamp captured just before the requesting
 *   span ended, used as the log record timestamp so it appears inside that
 *   span on the trace view. If undefined, falls back to `Date.now()`.
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
  requestedAtMs?: number,
  sourceService: string = 'llm-evals',
): Promise<void> {
  const evalCtx: EvaluatedContext = { responseModel, inputTokens, outputTokens, ttftMs, input, output, conversationId };

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

  try {
    await Promise.all([
      runEvalDual(evalRootCtx, traceId, spanId, requestedAtMs, sourceService, 'Bias', agentName, evalCtx, () => runBias(input, output)),
      runEvalDual(evalRootCtx, traceId, spanId, requestedAtMs, sourceService, 'Hallucination', agentName, evalCtx, () => runHallucination(input, output, groundingContext)),
      runEvalDual(evalRootCtx, traceId, spanId, requestedAtMs, sourceService, 'Relevance', agentName, evalCtx, () => runRelevance(input, output)),
    ]);
    evalRootSpan.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    evalRootSpan.recordException(error instanceof Error ? error : new Error(String(error)));
    evalRootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
  } finally {
    evalRootSpan.end();
  }
}
