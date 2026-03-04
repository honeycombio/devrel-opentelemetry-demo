# Plan: Comprehensive Gen-AI Telemetry for Chatbot

## Context

The chatbot in `src/chatbot` has partial gen-ai telemetry. The spec (`CHAT_TELEMETRY_SPEC.md`) requires all four OTel signals (Agent Spans, Model Spans, Events, Metrics) using gen-ai semantic conventions, and converting the product fetcher into a tool-calling agent.

## Current Gaps

1. **Missing `invoke_agent` wrapper spans** on `classifyScope` and `generateResponse` — they jump straight to `chat` spans
2. **`fetchProductInfo` is a raw HTTP fetch** — needs to become a Claude tool-calling agent
3. **No gen-ai events** — need `gen_ai.client.inference.operation.details` on chat spans
4. **No gen-ai metrics** — need `gen_ai.client.token.usage` counter and `gen_ai.client.operation.duration` histogram

## Files to Modify

| File | Changes |
|------|---------|
| `src/chatbot/src/agents.ts` | All agent/span/event/metric changes (~90% of work) |
| `src/chatbot/opentelemetry.js` | Add log exporter for events |
| `src/chatbot/package.json` | Add `@opentelemetry/sdk-logs` and `@opentelemetry/exporter-logs-otlp-grpc` |

## Implementation Steps

### Step 1: Dependencies (`package.json`)
Add explicit deps (matching existing 0.208.0 versions):
- `@opentelemetry/sdk-logs`: `0.208.0`
- `@opentelemetry/exporter-logs-otlp-grpc`: `0.208.0`

### Step 2: Log exporter (`opentelemetry.js`)
Add `OTLPLogExporter` + `BatchLogRecordProcessor` to the NodeSDK config so span events export properly.

### Step 3: Wrap `classifyScope` with `invoke_agent` span (`agents.ts`)
- Outer span: `invoke_agent scope_classifier` with `ATTR_GEN_AI_OPERATION_NAME = INVOKE_AGENT`
- Inner span (existing): `chat {MODEL}` becomes a child
- Set agent name, input/output messages on the agent span

### Step 4: Wrap `generateResponse` with `invoke_agent` span (`agents.ts`)
- Same pattern as Step 3 but for `response_generator`

### Step 5: Rewrite `fetchProductInfo` as tool-calling agent (`agents.ts`)
This is the biggest change. New flow:
1. Outer span: `invoke_agent product_fetcher`
2. Define Anthropic tool: `fetch_products` (takes optional `product_id`)
3. First `chat` span: `client.messages.create()` with tool definition — Claude decides to call it
4. `execute_tool fetch_products` span: run the actual HTTP fetch (extracted to `doProductFetch` helper). **Must preserve `propagation.inject(context.active(), headers)`** to propagate the current trace context into the HTTP request to the frontend service.
5. Second `chat` span: send tool result back to Claude, get final text response
6. Fallback: if Claude doesn't use the tool, fall back to direct fetch

New imports needed: `ATTR_GEN_AI_TOOL_NAME`, `ATTR_GEN_AI_TOOL_CALL_ID`, `ATTR_GEN_AI_TOOL_CALL_ARGUMENTS`, `ATTR_GEN_AI_TOOL_CALL_RESULT`, `GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL`

Update `formatOutputMessages` to handle `tool_use` content blocks.

### Step 6: Add gen-ai events (`agents.ts`)
On each `chat` span, after the API call, emit:
```
span.addEvent(EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS, {
  'gen_ai.system_instructions': systemPrompt,
  'gen_ai.input.messages': formatInputMessages(messages),
  'gen_ai.output.messages': formatOutputMessages(response),
})
```

### Step 7: Add gen-ai metrics (`agents.ts`)
At module scope, create:
- `meter.createCounter(METRIC_GEN_AI_CLIENT_TOKEN_USAGE)` — record input/output tokens with `ATTR_GEN_AI_TOKEN_TYPE`
- `meter.createHistogram(METRIC_GEN_AI_CLIENT_OPERATION_DURATION)` — record duration in seconds

Record after every `client.messages.create()` call with attributes: operation name, model, provider.

### Step 8: Additional attributes on all chat spans
- `ATTR_GEN_AI_SYSTEM_INSTRUCTIONS` — system prompt text
- `ATTR_GEN_AI_REQUEST_MAX_TOKENS` — max_tokens value

## Expected Span Tree After Changes

```
invoke_agent supervisor
  invoke_agent scope_classifier
    chat claude-haiku-4-5-20251001
  invoke_agent product_fetcher
    chat claude-haiku-4-5-20251001          (tool request)
    execute_tool fetch_products             (HTTP fetch with trace propagation)
    chat claude-haiku-4-5-20251001          (tool result → final text)
  invoke_agent response_generator
    chat claude-haiku-4-5-20251001
```

## Risks

- **Latency**: Product fetcher goes from 0 LLM calls to 2. Adds ~1-2s. Acceptable for demo.
- **Tool use reliability**: Claude may occasionally not call the tool. Fallback to direct fetch handles this.
- **Large attributes**: Product JSON on `ATTR_GEN_AI_TOOL_CALL_RESULT` could be large. Will truncate if needed.

## Verification

1. `cd src/chatbot && npm run build` — must compile cleanly
2. Run the service and send a chat question
3. Check Honeycomb traces: verify the span tree matches the expected hierarchy above
4. Check that each `chat` span has: gen-ai attributes, events, token counts
5. Check that `execute_tool` span has tool name, call ID, arguments, result
6. Check Honeycomb metrics: `gen_ai.client.token.usage` and `gen_ai.client.operation.duration` appear
