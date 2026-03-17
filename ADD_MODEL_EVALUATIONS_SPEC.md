# Goal:

- Add evaluations to LLM calls in chatbot for: bias, hallucination, and drift and report them in separate chat completions as child spans to the model calls

- Use the same model as the chatbot is using to run the autoevals, with appropriate prompting and autoevals judges.

- Run the evals asynchronously by calling an endpoint after LLM chat completions to begin evaluating the LLM call.

# Technical Requirements:

- Use the Braintrust AutoEvals library (home page https://www.braintrust.dev/docs/reference/autoevals, github https://github.com/braintrustdata/autoevals)
- Always use OpenAI gpt-4o as the eval judge model, regardless of which provider the chatbot is using. This avoids re-initialization complexity with the autoevals global `init()`.
- Create src/llm-evals as a node.js project
- Expose a simple web endpoint, like a POST to /api/evals that:
  - accepts a JSON payload with:
    - `traceparent` - W3C traceparent header (traceId + spanId of the LLM completion to evaluate)
    - `input` - the user's question/prompt
    - `output` - the LLM's response text
    - `groundingContext` - context for hallucination detection (product data, tool results, etc.)
    - `agentName` - identifier for which agent made the call (e.g. "product_fetcher", "response_generator")
  - processes evaluations in-process (no shared queue — each instance handles its own requests)
  - delegates to the Braintrust autoevals API for LLM evaluations
  - adds evaluation trace spans as children of the original LLM span, with evaluation events once each scorer completes
- Scaling: multiple llm-evals container instances can run behind the API gateway load balancer. No shared queue or external broker needed — the load balancer distributes POST requests across instances.
- Expose the llm-evals endpoint through the API gateway (frontend-proxy)
- The chatbot service calls the llm-evals endpoint (fire-and-forget) after `product_fetcher` (final turn) and `response_generator` LLM calls
- the evaluations should follow the techniques in the example in /tmp/chatbot/src/eval - but these are asynchronous evaluations decoupled from the original LLM call
- At startup, if the `llm.performEvals` feature flag is enabled and `OPENAI_API_KEY` is not set, log a warning and disable evaluations.

# Evaluation feature telemetry requirements

Add evaulations for:

- bias
- hallucination
- topic drift via the Relevance scorer - this should be drift in the answer versus what the input prompt asked

Also use chain of thought in the autoevals api to generate a chain of thought in arriving at a response. Set `useCoT: true` on all classifiers.

Attach evals to LLM chat completion operations for 'product_fetcher' (final turn) and 'response_generator' in the original code. Make it easy to call them and remove them with a helper method.

Use the correct telemetry for generative AI, v1.40.0 at https://opentelemetry.io/docs/specs/semconv/gen-ai/

# Constraints:

- the evaluations should follow the techniques in the example in /tmp/chatbot/src/eval - but keep in mind we need these to be asynchronous evaluations decoupled from the original LLM call - these are kicked off with the POST as fire-and-forget
- the chatbot passes input/output text directly in the POST payload (no Honeycomb API fetching)
- Add a feature flag (and set it to default to false) for running model evaluations
- Use the FlagD feature flagger to turn the feature on/off (llm.performEvals)

# Output Format:

- Proper evaluation spans should track all aspects of an LLM evaluation, record its own chat completion event, then end the span at the duration_ms of the completed evaluation.

# Failure Conditions:

- When we cannot perform an evaluation
- If we allow evaluations when the feature flag is off
