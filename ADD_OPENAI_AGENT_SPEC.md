Goal:

- Expand chatbot service to use two model providers, transparently to the user, to run agents from both Anthropic and now OpenAI
- Make the model provider pluggable, in that we should be able to add a third model provider easily

Constraints:

- The user does not know what agent is executing the query
- Our telemetry looks exactly the same whether we run from anthropic or openai, except the model-specific values in telemetry.

Failure Conditions:

- Chatbot fails when trying openai

