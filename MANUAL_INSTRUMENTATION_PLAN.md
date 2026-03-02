# Plan: Add GenAI Agentic Telemetry to Chatbot Service

## Context

The `ai-o11y-fedex` project uses the **OTel GenAI incubating semantic conventions** for rich agentic telemetry (operation names, agent names, message capture, finish reasons, etc.). The chatbot service in `devrel-opentelemetry-demo` has basic gen-ai attributes (model, token counts) but is missing the agentic layer. This plan brings the chatbot in line with the ai-o11y-fedex approach.

## Files to Modify

1. **`src/chatbot/package.json`** — add `@opentelemetry/semantic-conventions` dependency
2. **`src/chatbot/src/agents.ts`** — main instrumentation changes

## Changes

### Step 1: Add `@opentelemetry/semantic-conventions` dependency

Add `"@opentelemetry/semantic-conventions": "^1.27.0"` to `package.json` dependencies. This gives access to the incubating GenAI constants.

### Step 2: Replace hardcoded strings with semconv constants in `agents.ts`

Import from `@opentelemetry/semantic-conventions/incubating`:
```
ATTR_GEN_AI_AGENT_NAME, ATTR_GEN_AI_OPERATION_NAME, ATTR_GEN_AI_PROVIDER_NAME,
ATTR_GEN_AI_REQUEST_MODEL, ATTR_GEN_AI_RESPONSE_MODEL, ATTR_GEN_AI_RESPONSE_ID,
ATTR_GEN_AI_RESPONSE_FINISH_REASONS, ATTR_GEN_AI_USAGE_INPUT_TOKENS,
ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, ATTR_GEN_AI_INPUT_MESSAGES,
ATTR_GEN_AI_OUTPUT_MESSAGES, GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
GEN_AI_OPERATION_NAME_VALUE_CHAT, GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC
```

### Step 3: Rename spans to follow `{operation} {name}` convention

| Current span name | New span name |
|---|---|
| `supervisor` | `invoke_agent supervisor` |
| `scope_classifier` | `chat scope_classifier` |
| `product_fetcher` | `product_fetcher` (unchanged — not an LLM call) |
| `response_generator` | `chat response_generator` |

### Step 4: Update `setGenAIAttributes()` to capture full response details

Expand the helper to also set:
- `gen_ai.provider.name` = `"anthropic"` (replaces `gen_ai.system`)
- `gen_ai.response.id` = `response.id`
- `gen_ai.response.finish_reasons` = `[response.stop_reason]`
- `gen_ai.output.messages` = structured JSON of response content

Remove `gen_ai.system` (replaced by `gen_ai.provider.name`).

### Step 5: Add `gen_ai.input.messages` to chat spans

Each LLM call span (`scope_classifier`, `response_generator`) gets a `gen_ai.input.messages` attribute containing the serialized messages array in the same structured format as ai-o11y-fedex:
```json
[{"role": "user", "parts": [{"type": "text", "content": "..."}]}]
```

### Step 6: Add `gen_ai.operation.name` to all spans

- `supervisor` span: `gen_ai.operation.name` = `"invoke_agent"`
- `scope_classifier` / `response_generator` spans: `gen_ai.operation.name` = `"chat"`

### Step 7: Replace `chatbot.agent` with `gen_ai.agent.name`

All spans currently using `chatbot.agent` switch to `ATTR_GEN_AI_AGENT_NAME`. The custom `chatbot.*` domain attributes (result, scope, product_fetch, etc.) stay — they're application-specific and complement the semconv attributes.

### Step 8: Add output message formatting helper

Add a `formatOutputMessages()` function (adapted from ai-o11y-fedex) that serializes Anthropic response content blocks into the GenAI message format:
```json
[{"role": "assistant", "parts": [{"type": "text", "content": "..."}], "finish_reason": "end_turn"}]
```

And a `formatInputMessages()` helper for input messages.

## What stays the same

- `product_fetcher` span — not an LLM call, no gen_ai attributes needed, trace propagation to frontend remains
- All custom `chatbot.*` attributes — they're domain-specific context
- Error handling pattern with `recordException()`
- `opentelemetry.js` SDK setup — no changes needed
- `anthropic-client.ts` — no changes needed
- `index.ts` — no changes needed

## Verification

1. `cd src/chatbot && npm install` — confirm semconv package installs
2. `npm run build` — confirm TypeScript compiles
3. Run the service and send a test question; confirm traces in Honeycomb show:
   - `invoke_agent supervisor` as root span with `gen_ai.operation.name`, `gen_ai.agent.name`
   - `chat scope_classifier` and `chat response_generator` children with full gen_ai attributes (input/output messages, finish reasons, response ID, token counts)
   - `product_fetcher` child unchanged
