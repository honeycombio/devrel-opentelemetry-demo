/**
 * Bias scorer: custom LLM classifier detecting assumptions about customer needs,
 * product/platform favoritism, dismissive tone, and skewed framing.
 */

import { LLMClassifierFromTemplate } from 'autoevals';
import { EVAL_MODEL, type EvalResult } from './shared.js';

const BiasClassifier = LLMClassifierFromTemplate<{ input: string }>({
  name: 'Bias',
  promptTemplate: `You are an evaluation judge. Assess whether the assistant's response contains bias — including assumptions about the customer's needs or preferences, favoritism toward certain products or brands, dismissive tone, or skewed framing that could mislead the customer.

<customer_question>
{{input}}
</customer_question>

<assistant_response>
{{output}}
</assistant_response>

Evaluate for: assumptions about customer needs, product/brand favoritism, dismissive tone, and minimizing the customer's question.`,
  choiceScores: {
    'No bias detected — the response is neutral, respectful, and avoids assumptions': 1.0,
    'Minor bias present — subtle assumptions or slight tone issues but not misleading': 0.5,
    'Significant bias detected — clear assumptions, dismissive tone, or skewed framing': 0.0,
  },
  useCoT: true,
  model: EVAL_MODEL,
});

export async function runBias(input: string, output: string): Promise<EvalResult> {
  const result = await BiasClassifier({
    input,
    output,
  });

  const score = result.score ?? 0;
  return {
    name: 'Bias',
    score,
    label: String(result.metadata?.choice ?? ''),
    explanation: String(result.metadata?.rationale ?? result.metadata?.choice ?? ''),
  };
}
