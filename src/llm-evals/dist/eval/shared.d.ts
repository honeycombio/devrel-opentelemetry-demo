/**
 * Shared types and constants for LLM evaluation scorers.
 * Always uses OpenAI gpt-4o as the judge model.
 *
 * The autoevals library reads OPENAI_API_KEY from the environment automatically.
 * We pass EVAL_MODEL to each scorer call to ensure gpt-4o is used.
 */
export declare const EVAL_MODEL = "gpt-4o";
export interface EvalResult {
    name: string;
    score: number;
    label: string;
    explanation: string;
}
