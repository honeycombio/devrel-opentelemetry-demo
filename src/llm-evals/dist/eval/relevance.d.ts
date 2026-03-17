/**
 * Relevance (topic drift) scorer: does the response address what the user asked,
 * or has it drifted off-topic?
 */
import { type EvalResult } from './shared.js';
export declare function runRelevance(input: string, output: string): Promise<EvalResult>;
