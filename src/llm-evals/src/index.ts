/**
 * Kafka consumer for the eval pipeline.
 *
 * Topic: `llm-evals-spans`. Producer is the OTel collector's `kafka/llm-evals`
 * exporter (encoding: otlp_json), fed by the `traces/evals` pipeline. Each
 * Kafka message is one OTLP `ExportTraceServiceRequest` containing one or
 * more spans that survived the collector's `filter/keep_eval_anchors`.
 *
 * For each eval-anchor span we extract input/output messages, agent name,
 * model, and token usage from the standard gen_ai.* attributes, then call
 * evaluateChat which runs the scorers and writes results back as:
 *   1. A new eval trace (root span + 3 scorer spans), AND
 *   2. A `gen_ai.evaluation.result` log per scorer correlated to the
 *      original chat span via traceId+spanId — i.e. the log lands on the
 *      ACTUAL gen_ai span the eval is about, not a duplicate.
 */

import { Kafka } from 'kafkajs';
import { evaluateChat } from './eval/index.js';

const KAFKA_ADDR = process.env.KAFKA_ADDR;
if (!KAFKA_ADDR) {
  console.error('KAFKA_ADDR is not set');
  process.exit(1);
}

const TOPIC = 'llm-evals-spans';

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

// --- Core handler -----------------------------------------------------------

async function processSpan(resourceAttrs: Record<string, unknown>, span: OtlpSpan): Promise<void> {
  const spanAttrs = attrMap(span.attributes);
  const serviceName = String(resourceAttrs['service.name'] ?? '');

  // Skip tool-use rounds for product-reviews — those are not the final answer
  const finishReasons = spanAttrs['gen_ai.response.finish_reasons'];
  if (Array.isArray(finishReasons) && finishReasons.includes('tool_use')) return;

  const inputMessagesRaw = spanAttrs['gen_ai.input.messages'];
  const outputMessagesRaw = spanAttrs['gen_ai.output.messages'];
  if (typeof inputMessagesRaw !== 'string' || typeof outputMessagesRaw !== 'string') {
    console.warn(`Skipping span ${span.spanId} (${span.name}) — missing input/output message attrs`);
    return;
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
    return;
  }

  const input = extractUserText(inputMessages);
  const output = extractAssistantText(outputMessages);
  if (!input || !output) {
    console.warn(`Skipping span ${span.spanId} (${span.name}) — empty user/assistant text`);
    return;
  }

  await evaluateChat(
    span.traceId,
    span.spanId,
    input,
    output,
    extractGrounding(inputMessages),
    String(spanAttrs['gen_ai.agent.name'] ?? serviceName),
    String(spanAttrs['gen_ai.request.model'] ?? 'unknown'),
    Number(spanAttrs['gen_ai.usage.input_tokens'] ?? 0),
    Number(spanAttrs['gen_ai.usage.output_tokens'] ?? 0),
    Number(spanAttrs['gen_ai.server.time_to_first_token'] ?? 0),
  );
}

async function main() {
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  console.log(`LLM Evals consumer connected, waiting for messages on topic "${TOPIC}"`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      let payload: OtlpExportTraceServiceRequest;
      try {
        payload = JSON.parse(message.value.toString());
      } catch {
        console.warn('Skipping non-JSON message');
        return;
      }
      for (const rs of payload.resourceSpans ?? []) {
        const resourceAttrs = attrMap(rs.resource?.attributes);
        for (const ss of rs.scopeSpans ?? []) {
          for (const span of ss.spans ?? []) {
            try {
              await processSpan(resourceAttrs, span);
            } catch (err) {
              console.error(`Eval failed for span ${span.spanId}:`, err);
            }
          }
        }
      }
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
