/**
 * Bias scorer: custom LLM classifier detecting assumptions about customer needs,
 * product/platform favoritism, dismissive tone, and skewed framing.
 */
import { type EvalResult } from './shared.js';
export declare function runBias(input: string, output: string): Promise<EvalResult>;
