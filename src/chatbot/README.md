# Chatbot Service

An AI-powered customer service chatbot for the OpenTelemetry Demo store. It answers product-related questions using a multi-agent architecture powered by Anthropic's Claude API, with full OpenTelemetry instrumentation following GenAI semantic conventions.

## Architecture

The chatbot uses a **supervisor pattern** with three sub-agents:

1. **Scope Classifier** - Determines if the user's question is about products/shopping (in-scope) or something else (out-of-scope). Uses the research model.
2. **Product Fetcher** - A tool-calling agent that fetches product data from the frontend's `/api/products` endpoint. Uses the research model. Supports fetching all products or a specific product by ID.
3. **Response Generator** - Takes the product data and the user's question and writes a helpful HTML-formatted answer. Uses the writer model.

The supervisor orchestrates these in sequence: classify -> fetch -> respond. Out-of-scope questions are rejected after step 1.

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/chat/question` | POST | Ask a question. Body: `{ "question": "...", "productId": "..." }` |
| `/chat/feedback` | POST | Submit feedback on an answer. Body: `{ "traceId": "...", "spanId": "...", "sentiment": "good"\|"bad" }` |
| `/chat/demo-enable` | POST | Force-enable the chatbot (bypasses feature flag) |
| `/chat/demo-disable` | POST | Disable the demo override |

NOTE: the demo-enable and demo-disable endpoints are older artifacts. We now use FlagD (see below).

## Requirements

### Anthropic API Key

The chatbot requires an Anthropic API key. Set it as an environment variable before deploying:

```bash
export ANTHROPIC_API_KEY=your-key-here
```

When deploying with `./run`, the key is passed via skaffold to the Kubernetes deployment. Include `chatbot` in the service list:

```bash
ANTHROPIC_API_KEY=your-key-here ./run chatbot
```

Or export it first and include chatbot in the services:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
./run chatbot frontend frontend-proxy
```

### Feature Flags (FlagD)

The chatbot connects to a FlagD instance for feature flag evaluation. Three flags control behavior:

| Flag | Type | Default | Description |
|---|---|---|---|
| `chatbot.enabled` | boolean | `false` | Master switch for the chatbot. Must be `true` (or demo mode enabled) for the chatbot to respond. |
| `chatbot.research.model` | string | `claude-haiku-4-5` | Claude model used by the scope classifier and product fetcher agents. |
| `chatbot.writer.model` | string | `claude-haiku-4-5` | Claude model used by the response generator agent. |

To add these flags to your FlagD config, the run script patches FlagD's configmap and restarts the service using this script:

```bash
scripts/patch-flagd-config.sh [namespace]
```

This patches the `flagd-config` ConfigMap and restarts FlagD. The namespace defaults to `$USER-local`.

Tweak model names as needed, and as Claude comes up with new variants.

## OpenTelemetry Instrumentation

The service emits rich following the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):

- **Traces**: Nested spans for each agent invocation (`invoke_agent`), LLM chat call (`chat`), and tool execution (`execute_tool`)
- **Metrics**: `gen_ai.client.token.usage` (counter) and `gen_ai.client.operation.duration` (histogram)
- **Span events**: `gen_ai.client.inference.operation.details` with system prompts, input/output messages
- **Feedback spans**: User feedback is linked back to the original answer via trace/span context propagation

The OTel SDK is initialized via `opentelemetry.js` (loaded with `--require`) and exports traces, metrics, and logs over OTLP/gRPC.

## Development

Claude wrote this. I did add tests, so this is how you'd verify them.

```bash
cd src/chatbot
npm install
npm run build    # compile TypeScript
npm test         # run tests with vitest
```

## Tests

Unit tests are in `src/__tests__/agents.test.ts`. They mock the Anthropic client and OpenTelemetry API to verify:

- Happy path (in-scope question with tool-use flow)
- Out-of-scope rejection
- LLM error handling
- Fallback when tool-use is not triggered
- Telemetry: correct span names, token metrics, inference events
