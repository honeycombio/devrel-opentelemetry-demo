Goal:

- Capture as much agentic telemetry as we can for this chatbot service in src/chatbot.

Constraints:

- Use https://opentelemetry.io/docs/specs/semconv/gen-ai/ conventions - including the Anthropic semantic conventions referenced in the documentation
- Use all four signals of Events, Metrics, Model Spans, and Agent Spans where appropriate
- Convert the fetchProductInfo call into a gen-ai tool call - and use it in a new agent in the agent flow in src/agents.ts
- Always capture input and output of each call, token use and other useful attributes
- Always follow gen-ai conventions - ask if unsure

Output Format:

- Additional trace spans for gen-ai telemetry that we are missing currently
- convert the product_fetcher spans (ex: span id cc8ac4d84ecfd095 in trace e2ef25b2ef0d9e16a019aae5ec3576bc) to an agent and show all three agents as being invoked with invoke_agent before writing the chat span

Failure Conditions:

- If telemetry breaks for the trace and doesn't show gen-ai data
- If the new tool to be used for product fetching fails in operation
