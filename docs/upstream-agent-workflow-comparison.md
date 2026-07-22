# Upstream LLM agent workflow vs. our `storechat` — comparison notes

Working notes for deciding whether to reuse upstream's new agent/MCP/chatbot
feature as-is, or keep/adapt our own `storechat` implementation.

## What upstream added

Three new services, landed in a sequence of PRs after our fork point
(merge-base `e4743cf0`, 2025-11-19):

- `899c90a8` "adding AI agents" (#3225, 2026-04-09)
- `78fbaa88` "feat: add AI agents guidance files" (#3404, 2026-05-23)
- `78e00fdb` "Add Agent, MCP and Chatbot to otel-demo" (#3455, 2026-06-24) — the
  actual implementation

Architecture (`src/agent`, `src/mcp`, `src/chatbot`):

- **`src/mcp`** — an MCP server exposing the existing shop operations
  (cart, checkout, product catalog, recommendations, currency, shipping
  quote) as MCP tools over `astronomy_shop_mcp_server.py`.
- **`src/agent`** — a LangChain `create_agent` ReAct-style agent
  (`langchain` + `langchain_mcp_adapters`) that either calls the tools
  directly or, if `MCP_ENABLED=True`, loads them dynamically via
  `load_mcp_tools` from the MCP server. Model is provider-agnostic
  (`ChatLLM` wrapper — OpenAI/Azure/Anthropic per VCR cassette fixtures).
  Instrumented with **Traceloop/OpenLLMetry** (`@workflow` decorator).
- **`src/chatbot`** — a FastAPI chat UI (`chat_interface.py`) that talks to
  the agent over HTTP, wired into `compose.agent.yaml` and routed at
  `/chatbot/` in Envoy.
- Purpose: a **shopping assistant** — "find me a telescope under $200",
  add-to-cart, checkout — driving the existing storefront tools.

## What we built (`src/storechat`)

- Added `f8246285`/`5f83ad18` shortly after the fork point — a **customer
  support** assistant for "Telescope Shop" (order status, shipping lookup,
  refunds), not a shopping/checkout assistant.
- Multi-agent supervisor pattern using **AWS Strands Agents SDK**
  (`strands.Agent`, `BedrockModel`) — supervisor + `order_status_agent` +
  `refund_agent` sub-agents, each with its own Bedrock model (Haiku for the
  supervisor, Nova Lite/Micro for sub-agents) and prompt-cache tuning.
- Tools are custom (`lookup_orders`, `get_order`, `check_shipping`,
  `refund_order`) against our own `accounting` order store, not the
  catalog/cart tools.
- Instrumented via Strands' native OTel emission, reshaped by our own OTTL
  collector transform (see `genai-span-events-to-attributes` skill /
  `storechat-genai-semconv-validation` memory) to match GenAI semconv.
  No Traceloop/OpenLLMetry dependency.
- Also added `llm-evals` (chat-turn evaluation pipeline) and `llm`
  (shared LLM utilities), and `product-reviews` (GenAI summaries) — none
  of which exist upstream.

## Conflict surface if we pull in upstream's feature verbatim

- `src/frontend-proxy/envoy.tmpl.yaml` — upstream routes `/chatbot/` to a
  `chatbot` cluster; we route `/store-chat/` to a `store-chat` cluster.
  Not a textual conflict (different paths/clusters) but our file has
  otherwise drifted (upstream renamed `api-gateway`→`frontend`, restructured
  the OTel access-log config block, added `/opamp/` and `/profiles/`
  routes) — a real merge will need careful reconciliation here, not just
  the agent bits.
- `compose.agent.yaml` / Makefile `start-agentic` target are net-new from
  upstream — low conflict risk, additive.
- No overlap in Python deps/frameworks: LangChain+Traceloop (upstream) vs.
  Strands+Bedrock (ours). They can coexist as separate services; there is
  no shared library to reconcile.

## Assessment

These are two different demos solving different scenarios (shopping agent
vs. support/refund agent) built on different stacks (LangChain/Traceloop/
OpenAI-class models vs. Strands/Bedrock). Reuse isn't a drop-in swap:

1. **Keep both, run side-by-side** — pull in upstream's `agent`/`mcp`/
   `chatbot` untouched at `/chatbot/`, keep `storechat` at `/store-chat/`.
   Lowest effort, no loss of our custom refund/order-status demo, gives us
   the upstream shopping-agent scenario for free. Envoy route addition is
   additive, not conflicting.
2. **Replace `storechat` with upstream's agent** — loses our refund/
   order-status scenario and the Bedrock/Strands-specific GenAI semconv
   story we've built demos and OTTL processing around. Not recommended —
   that's bespoke work we'd be throwing away.
3. **Merge scenarios into one multi-agent app** — e.g. add our
   order-status/refund tools as additional MCP tools/agents inside
   upstream's `src/agent`, dropping `storechat` entirely. Highest effort,
   highest payoff (single coherent agent demo, unifies on one
   instrumentation story) — but a real rewrite, not a merge.

**Recommendation: option 1** as the near-term move (pull upstream's feature
in as an additional, independent service) — it's non-destructive and low
risk. Option 3 is worth doing later if we want a single "flagship" agent
demo instead of two, but it's a separate, larger project.
