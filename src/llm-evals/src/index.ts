/**
 * Kafka consumer for the eval pipeline.
 *
 * Topic: `llm-evals-spans`. Producer is the OTel collector's `kafka/llm-evals`
 * exporter (encoding: otlp_json), fed by the `traces/evals` pipeline. Each
 * Kafka message is one OTLP `ExportTraceServiceRequest` containing one or
 * more spans that survived the collector's `filter/keep_eval_anchors`.
 *
 * Per message we:
 *   1. For every eval-anchor span, call `runEvalScorers` — it emits the
 *      `eval - llm-evals` root span and three child scorer spans in real
 *      time as scorers complete. These spans CAN duplicate on a kafka
 *      redelivery; that's accepted as the cost of timely scorer-latency
 *      observability.
 *   2. Only after phase 1 has succeeded for *every* span do we call
 *      `emitEvalLogs`, which writes the `gen_ai.evaluation.result` log
 *      records back onto the chatbot trace. kafkajs auto-commits the
 *      offset after `eachMessage` returns, so any phase-1 failure aborts
 *      before logs land and the message is redelivered. End-to-end the
 *      chatbot-trace logs are exactly-once-or-zero per chat span.
 *
 * A background heartbeat ticker keeps the consumer in the group while
 * Bedrock calls are in flight: kafkajs only sends heartbeats *between*
 * eachMessage invocations, and the default 30s sessionTimeout is shorter
 * than three parallel Bedrock Converse calls under throttling.
 */

import { Kafka } from 'kafkajs';
import {
  runEvalScorers,
  emitEvalLogs,
  type CompletedScorers,
  type EvaluatedContext,
} from './eval/index.js';

const KAFKA_ADDR = process.env.KAFKA_ADDR;
if (!KAFKA_ADDR) {
  console.error('KAFKA_ADDR is not set');
  process.exit(1);
}

const TOPIC = 'llm-evals-spans';
const HEARTBEAT_KEEPALIVE_MS = 5_000;
// Maximum messages we'll process in parallel — one worker per assigned
// partition. Should match (or exceed) the topic's partition count, set in
// `src/kafka/Dockerfile` via KAFKA_NUM_PARTITIONS. Setting higher than the
// partition count is harmless; setting lower caps parallelism.
const PARTITIONS_CONCURRENCY = 8;

const kafka = new Kafka({ brokers: [KAFKA_ADDR], clientId: 'llm-evals' });
const consumer = kafka.consumer({ groupId: 'llm-evals' });

// --- OTLP-JSON shape (subset we care about) ---------------------------------

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: Array<{ key: string; value: OtlpAnyValue }> };
}
interface OtlpAttribute { key: string; value: OtlpAnyValue }
interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  attributes?: OtlpAttribute[];
}
interface OtlpResource { attributes?: OtlpAttribute[] }
interface OtlpExportTraceServiceRequest {
  resourceSpans?: Array<{
    resource?: OtlpResource;
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
}

function unwrapValue(v: OtlpAnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(unwrapValue);
  if (v.kvlistValue) {
    const obj: Record<string, unknown> = {};
    for (const kv of v.kvlistValue.values ?? []) obj[kv.key] = unwrapValue(kv.value);
    return obj;
  }
  return undefined;
}

function attrMap(attrs?: OtlpAttribute[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs ?? []) out[a.key] = unwrapValue(a.value);
  return out;
}

// --- Message-shape helpers --------------------------------------------------

// Two on-the-wire shapes are common:
//   * Bedrock-style content blocks: `content: [{text}]` or `content: "string"`
//   * GenAI-semconv "parts" (Strands): `parts: [{type: "text", content}]`
// Each block can be a plain string, a `{text}` Bedrock block, or a
// `{type: "text", content}` semconv part.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(blocks: any): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((b: any) => {
      if (typeof b === 'string') return b;
      if (typeof b?.text === 'string') return b.text;
      if (b?.type === 'text' && typeof b?.content === 'string') return b.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function messageText(m: any): string {
  if (Array.isArray(m?.parts)) return extractText(m.parts);
  return extractText(m?.content);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messageText(messages[i]);
  }
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAssistantText(messages: any[]): string {
  for (const m of messages) {
    if (m?.role === 'assistant') return messageText(m);
  }
  return '';
}

/**
 * Grounding context for the Hallucination scorer = the tool results the model
 * was given. Bedrock encodes these as `toolResult` blocks inside user-role
 * messages. Strands keeps the same convention. Tool-text blocks (Strands)
 * are also picked up for completeness.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractGrounding(messages: any[]): string {
  const groundings: string[] = [];
  for (const m of messages ?? []) {
    if (m?.role === 'tool') {
      groundings.push(extractText(m.content));
    }
    if (Array.isArray(m?.content)) {
      for (const block of m.content) {
        if (block?.toolResult?.content) {
          groundings.push(extractText(block.toolResult.content));
        }
      }
    }
  }
  return groundings.filter(Boolean).join('\n\n');
}

// --- Phase 1: scorers + eval traces (per span) ------------------------------

/** A span that has finished phase 1 and is ready for chatbot-trace log emission. */
interface ReadyForLogs {
  traceId: string;
  spanId: string;
  completed: CompletedScorers;
}

/**
 * Phase 1 for a single span: validate, then run all three scorers via
 * `runEvalScorers`. Eval-trace spans are emitted in real time inside that
 * call. Returns `null` for spans that should be skipped (tool-use rounds,
 * missing/invalid attrs); throws if any scorer fails so the caller can
 * abort the whole message before any chatbot-trace logs are emitted.
 */
async function runPhase1(
  resourceAttrs: Record<string, unknown>,
  span: OtlpSpan,
): Promise<ReadyForLogs | null> {
  const spanAttrs = attrMap(span.attributes);
  const serviceName = String(resourceAttrs['service.name'] ?? '');

  // Skip tool-use rounds for product-reviews — those are not the final answer
  const finishReasons = spanAttrs['gen_ai.response.finish_reasons'];
  if (Array.isArray(finishReasons) && finishReasons.includes('tool_use')) return null;

  const inputMessagesRaw = spanAttrs['gen_ai.input.messages'];
  const outputMessagesRaw = spanAttrs['gen_ai.output.messages'];
  if (typeof inputMessagesRaw !== 'string' || typeof outputMessagesRaw !== 'string') {
    console.warn(`Skipping span ${span.spanId} (${span.name}) — missing input/output message attrs`);
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inputMessages: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outputMessages: any[];
  try {
    inputMessages = JSON.parse(inputMessagesRaw);
    outputMessages = JSON.parse(outputMessagesRaw);
  } catch (e) {
    console.warn(`Failed to parse message JSON for span ${span.spanId}:`, e);
    return null;
  }

  const input = extractUserText(inputMessages);
  const output = extractAssistantText(outputMessages);
  if (!input || !output) {
    console.warn(`Skipping span ${span.spanId} (${span.name}) — empty user/assistant text`);
    return null;
  }

  const evalCtx: EvaluatedContext = {
    responseModel: String(spanAttrs['gen_ai.request.model'] ?? 'unknown'),
    inputTokens: Number(spanAttrs['gen_ai.usage.input_tokens'] ?? 0),
    outputTokens: Number(spanAttrs['gen_ai.usage.output_tokens'] ?? 0),
    ttftMs: Number(spanAttrs['gen_ai.server.time_to_first_token'] ?? 0),
    input,
    output,
  };

  const agentName = String(spanAttrs['gen_ai.agent.name'] ?? serviceName);
  const completed = await runEvalScorers(
    span.traceId,
    span.spanId,
    agentName,
    evalCtx,
    extractGrounding(inputMessages),
  );

  return { traceId: span.traceId, spanId: span.spanId, completed };
}

// --- Message-level pipeline -------------------------------------------------

async function processMessage(
  payload: OtlpExportTraceServiceRequest,
): Promise<void> {
  // Collect every span in the message and run phase 1 for all in parallel.
  // Eval-trace spans emit live inside runEvalScorers; the chatbot-trace
  // logs are gated on every phase 1 succeeding.
  const tasks: Array<Promise<ReadyForLogs | null>> = [];
  for (const rs of payload.resourceSpans ?? []) {
    const resourceAttrs = attrMap(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        tasks.push(runPhase1(resourceAttrs, span));
      }
    }
  }

  // Any rejection aborts the whole message before any chatbot-trace log
  // is emitted. Eval-trace spans for the failed batch may already be in
  // Honeycomb — accepted trade-off for live scorer observability.
  const readied = await Promise.all(tasks);

  for (const r of readied) {
    if (!r) continue;
    emitEvalLogs(r.traceId, r.spanId, r.completed);
  }
}

async function main() {
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  console.log(`LLM Evals consumer connected, waiting for messages on topic "${TOPIC}"`);

  await consumer.run({
    partitionsConsumedConcurrently: PARTITIONS_CONCURRENCY,
    eachMessage: async ({ message, heartbeat }) => {
      if (!message.value) return;
      let payload: OtlpExportTraceServiceRequest;
      try {
        payload = JSON.parse(message.value.toString());
      } catch {
        console.warn('Skipping non-JSON message');
        return;
      }

      // Keep the consumer alive in the group while Bedrock calls run.
      // kafkajs otherwise only heartbeats between messages, and three
      // parallel Converse calls can exceed the 30s sessionTimeout under
      // throttling — leading to a rebalance that redelivers the message
      // and produces duplicate eval outputs.
      const hb = setInterval(() => {
        heartbeat().catch(() => undefined);
      }, HEARTBEAT_KEEPALIVE_MS);

      try {
        await processMessage(payload);
      } finally {
        clearInterval(hb);
      }
      // Returning normally lets kafkajs auto-commit the offset. Any
      // failure inside processMessage propagates and skips the commit,
      // so the message is redelivered and re-evaluated.
    },
  });
}

main().catch((err) => {
  console.error('Fatal error in llm-evals consumer:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await consumer.disconnect();
});
