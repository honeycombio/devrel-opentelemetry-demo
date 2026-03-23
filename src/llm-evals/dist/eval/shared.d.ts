/**
 * Shared types and Bedrock adapter for LLM evaluation scorers.
 *
 * The autoevals library accepts an optional `client` parameter implementing
 * the OpenAI chat.completions.create interface. We provide a minimal Bedrock
 * adapter so the same autoevals prompts run against Claude Haiku on Bedrock.
 */
/**
 * Minimal OpenAI-compatible adapter backed by Bedrock Converse API.
 * autoevals calls client.chat.completions.create({ messages, model, ... })
 * and expects { choices: [{ message: { content } }], usage: { ... } }.
 */
export declare const bedrockAdapter: any;
export declare const EVAL_MODEL = "bedrock-haiku";
export interface EvalResult {
    name: string;
    score: number;
    label: string;
    explanation: string;
}
