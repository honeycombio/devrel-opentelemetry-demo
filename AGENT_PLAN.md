# Implementation Plan

## 1. Scope and design decisions
- **Language: TypeScript.**
- Keep the existing frontend entrypoint (`/api/product-ask-ai-assistant/:productId`) so UI wiring remains stable.
- Implement new `chatbot` as a standalone HTTP service with root path `/chat`.
- Use Anthropic only in `chatbot`; remove dependency on product-reviews AI for product-page questions.
- Enforce hard guardrails:
  - Disabled or missing `ANTHROPIC_API_KEY` => `"The Chatbot is Unavailable"`.
  - Out-of-scope question => `"AI Response: Sorry, I'm not able to answer that question."`
- Preserve trace continuity from browser -> frontend API route -> chatbot -> product catalog fetch.

## 2. Chatbot service buildout (`src/chatbot`)
- Create service endpoints:
  - `POST /chat/question`
  - `POST /chat/demo-enable`
  - `POST /chat/demo-disable`
- Add runtime toggle state (default disabled on startup).
- Implement 4-agent orchestration flow in code:
  - Supervisor agent (orchestrates run and branching).
  - Scope classifier sub-agent (catalog-only gate).
  - Product info sub-agent (`GET /products` and optional in-memory filtering by `productId`/query terms).
  - Response sub-agent (final response formatting).
- Add strict output rules so non-catalog/off-policy answers never leak.
- Add Anthropic SDK integration using `ANTHROPIC_API_KEY`.
- Add OTel instrumentation:
  - Service name: `chatbot`.
  - Spans for supervisor + each sub-agent step.
  - Propagation extract/inject for `traceparent`, `tracestate`, `baggage`.
  - OTLP export aligned with current project env conventions.

## 3. Frontend API and UI integration
- Update `src/frontend/pages/api/product-ask-ai-assistant/[productId]/index.ts`:
  - Replace current ProductReviewService gRPC AI call with HTTP call to `CHATBOT_ADDR/chat/question`.
  - Forward trace headers from incoming request to chatbot request.
  - Send `{ question, productId }`.
- Keep `src/frontend/gateways/Api.gateway.ts` and provider contract unchanged unless needed.
- Update `src/frontend/components/ProductReviews/ProductReviews.tsx`:
  - Remove/hide three prefab quick-prompt buttons.
  - Keep text input + Ask button + response area.

## 4. Runtime configuration and routing
- **No docker-compose support — this demo does not use docker-compose.**
- Add envs to `.env` and K8s/Skaffold wiring:
  - `CHATBOT_PORT`, `CHATBOT_ADDR`, `ANTHROPIC_API_KEY`.
- Update frontend env exposure:
  - Add `CHATBOT_ADDR` in `src/frontend/next.config.js` and relevant env blocks.
- Update proxy routing in `src/frontend-proxy/envoy.tmpl.yaml`:
  - Add `/chat` route to chatbot cluster before catch-all `/`.
  - Add chatbot cluster definition.
- Add service build wiring in `skaffold.yaml` only.

## 5. Skaffold + ECR path for local namespace only
- **Local namespace deployment only — no production Helm chart changes.**
- Add chatbot as a Skaffold artifact.
- Extend Helm value templates in `skaffold.yaml` for chatbot image override keys (same pattern as `services.productReviews.*` and `services.llm.*`).
- Extend `skaffold-config/charts/otel-services`:
  - Add `services.chatbot` in values.
  - Add deployment/service templates for chatbot.
- Ensure `./run` path works unchanged:
  - `-d "$CONTAINER_REGISTRY"` should push chatbot to private ECR prefix when built.
  - Existing cluster can still run GHCR for untouched services.
- Keep per-namespace behavior: only local namespace gets chatbot rollout.

## 6. Testing and validation
- Unit tests in chatbot:
  - Toggle behavior.
  - Missing API key behavior.
  - Scope classifier fallback behavior.
- API tests:
  - `POST /chat/question` with disabled and enabled modes.
  - `demo-enable`/`demo-disable` idempotency.
- Frontend integration checks:
  - Product page Ask AI calls chatbot-backed endpoint.
  - Quick prompt buttons absent.
- Trace validation:
  - Single trace includes frontend API span and chatbot sub-agent spans.
  - `service.name=chatbot` visible.
- Skaffold validation in local namespace:
  - Confirm chatbot image is from private ECR repo after `./run`.
  - Confirm other services may remain GHCR unless rebuilt/overridden.

## 7. Rollout order
- Phase 1: chatbot service skeleton + toggle + unavailable messaging. **DONE**
  - Created `src/chatbot/` with: `package.json`, `tsconfig.json`, `opentelemetry.js`, `src/index.ts`, `Dockerfile`
  - Express server on `CHATBOT_PORT` (default 8087)
  - Three endpoints: `POST /chat/question`, `POST /chat/demo-enable`, `POST /chat/demo-disable`
  - Toggle defaults disabled; missing API key also returns unavailable
  - OTel instrumentation file matches existing project pattern (CommonJS `--require` preload)
  - Dockerfile uses multi-stage build matching project conventions (node:22-slim builder, distroless runtime)
  - All smoke tests passed
- Phase 2: frontend API route switch + UI quick-prompt removal. **DONE**
  - Updated API route to HTTP fetch to `CHATBOT_ADDR/chat/question` instead of ProductReviewService gRPC
  - Injects OTel trace context headers (`traceparent`, `tracestate`) via `propagation.inject` for trace continuity
  - Falls back to "The Chatbot is Unavailable" when `CHATBOT_ADDR` is unset or chatbot returns error
  - Added `CHATBOT_PORT`, `CHATBOT_ADDR`, `CHATBOT_DOCKERFILE` to `.env`
  - Added `CHATBOT_ADDR` to `next.config.js` env exposure
  - Removed 3 quick-prompt buttons from `ProductReviews.tsx`
  - Removed dead `QuickPromptButton` and `AskAIControls` styled components
  - TypeScript compiles cleanly
- Phase 3: Anthropic agent flow + product fetch logic + strict guardrails. **DONE**
  - Created `src/chatbot/src/anthropic-client.ts` — singleton Anthropic SDK client with lazy init
  - Created `src/chatbot/src/agents.ts` — 4-agent orchestration:
    - **Supervisor** (`handleQuestion`) — orchestrates flow with parent span, routes to sub-agents
    - **Scope Classifier** (`classifyScope`) — Haiku LLM call, returns `inScope` boolean; out-of-scope → exact fallback text
    - **Product Fetcher** (`fetchProductInfo`) — HTTP GET to frontend `/api/products[/:productId]` with OTel trace propagation
    - **Response Generator** (`generateResponse`) — Haiku LLM call given product data + question
  - Updated `src/chatbot/src/index.ts` — wired `handleQuestion` into POST `/chat/question`, added input validation
  - Each agent step gets its own OTel span under `supervisor` parent for trace visibility
  - Guardrails: scope classifier gates all questions; non-catalog → `"AI Response: Sorry, I'm not able to answer that question."`
  - Model: `claude-haiku-4-5-20251001` (fast/cheap for demo sub-agents)
  - Product data fetched from frontend via `FRONTEND_ADDR` env var (already in `.env`)
  - TypeScript compiles cleanly
- Phase 4: OTel propagation and telemetry hardening. **DONE**
  - Added `RuntimeNodeInstrumentation` to `opentelemetry.js` (event loop, GC metrics) matching payment service pattern
  - Added `recordException()` helper — records exception as span event + sets error status on all catch blocks
  - Added `setGenAIAttributes()` helper — `gen_ai.system`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` on LLM spans
  - Applied GenAI attributes to `scope_classifier` and `response_generator` spans
  - Product fetcher now logs fetch URL attribute and sets error status on non-200 responses
  - HTTP handler span enriched with `chatbot.demo_enabled`, `chatbot.available`, `chatbot.question`, `chatbot.product_id`, `chatbot.result`
  - Added `@opentelemetry/instrumentation-runtime-node@0.22.0` dependency (aligned with payment service)
  - Incoming trace propagation handled automatically by HTTP auto-instrumentation (no manual extract needed)
  - TypeScript compiles cleanly
- Phase 5: Skaffold/Helm/Envoy wiring and namespace deploy. **DONE**
  - Added `chatbot` build artifact in `skaffold.yaml` (context `.`, dockerfile `src/chatbot/Dockerfile`)
  - Added `services.chatbot.imageOverride` setValueTemplates in `skaffold.yaml` otel-services release
  - Added `services.chatbot` in `skaffold-config/charts/otel-services/values.yaml` (port 8087, GHCR default image)
  - Added chatbot Deployment template in `deployment.yaml` (same pattern as productReviews/llm)
  - Added chatbot Service template in `service.yaml` (ClusterIP, port 8087)
  - Added `/chat` route in `envoy.tmpl.yaml` before catch-all `/` route, plus chatbot cluster definition
  - Added `CHATBOT_ADDR=http://chatbot:8087` to frontend envOverrides in `demo-values.yaml`
  - Added `CHATBOT_PORT=8087` to frontend-proxy envOverrides for envsubst in envoy template
  - Chatbot env includes `CHATBOT_PORT`, `FRONTEND_ADDR`, `ANTHROPIC_API_KEY`, plus OTel standard vars
- Phase 6: test pass + trace verification + doc update.

## 8. Acceptance criteria
- Asking from product page hits chatbot path and returns synchronous response.
- Disabled or missing key always returns `"The Chatbot is Unavailable"`.
- Non-catalog questions always return exact fallback text.
- `/chat/demo-enable` and `/chat/demo-disable` control execution as expected.
- Trace continuity confirmed across frontend and chatbot.
- Deployment works in Skaffold AWS namespace with ECR-based chatbot image.
