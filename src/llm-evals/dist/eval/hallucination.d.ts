/**
 * Hallucination scorer: are claims in the response fabricated (not from the provided context)?
 * Uses Faithfulness with context = user question + grounding context combined.
 */
import { type EvalResult } from './shared.js';
export declare function runHallucination(input: string, output: string, groundingContext: string): Promise<EvalResult>;
