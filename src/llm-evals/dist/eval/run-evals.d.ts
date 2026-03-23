/**
 * Orchestrates eval scorer execution and emits OTel spans in two traces:
 *
 * 1. Original chatbot trace (via remote parent from traceparent):
 *    3 eval scorer child spans with gen_ai.evaluation.result events
 *    and span links to the eval trace root.
 *
 * 2. New eval trace:
 *    1 root span + 3 eval scorer child spans with the same events.
 *
 * Scorers run once; results are written to both traces.
 */
/**
 * Run bias, hallucination, and relevance evaluations.
 * Results are written to both the original chatbot trace and a new eval trace.
 *
 * @param traceId - Trace ID from the chatbot's chat completion span
 * @param spanId - Span ID from the chatbot's chat completion span
 * @param input - The user's input/question
 * @param output - The LLM's response text
 * @param groundingContext - Context for hallucination detection
 * @param agentName - Which agent made the call (e.g. "response_generator")
 */
export declare function evaluateChat(traceId: string, spanId: string, input: string, output: string, groundingContext: string, agentName: string, responseModel: string, inputTokens: number, outputTokens: number, ttftMs: number): Promise<void>;
