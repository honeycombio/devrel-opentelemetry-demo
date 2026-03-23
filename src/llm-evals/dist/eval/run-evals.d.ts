/**
 * Orchestrates eval scorer execution and emits OTel child spans.
 *
 * Each scorer gets its own child span named "chat - Evaluation - <type>"
 * with a gen_ai.evaluation.result span event containing the results.
 * All three evals run in parallel via Promise.all.
 *
 * Unlike the in-process reference implementation, this version creates
 * child spans from a deserialized W3C traceparent (remote parent).
 */
/**
 * Run bias, hallucination, and relevance evaluations as child spans
 * of the remote parent identified by the traceparent header.
 *
 * @param traceparent - W3C traceparent header (00-traceId-spanId-flags)
 * @param input - The user's input/question
 * @param output - The LLM's response text
 * @param groundingContext - Context for hallucination detection
 * @param agentName - Which agent made the call (e.g. "product_fetcher")
 */
export declare function evaluateChat(traceparent: string, input: string, output: string, groundingContext: string, agentName: string): Promise<void>;
