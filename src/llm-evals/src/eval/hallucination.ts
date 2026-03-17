/**
 * Hallucination scorer: are claims in the response fabricated (not from the provided context)?
 * Uses Faithfulness with context = user question + grounding context combined.
 */

import { Faithfulness } from 'autoevals';
import { EVAL_MODEL, type EvalResult } from './shared.js';

function scoreToHallucinationLabel(score: number): string {
  if (score >= 0.8) return 'no_hallucination';
  if (score >= 0.5) return 'minor_hallucination';
  return 'hallucinated';
}

function summarizeFaithfulness(metadata: Record<string, unknown> | undefined | null): string {
  const verdicts = metadata?.faithfulness;
  if (!Array.isArray(verdicts) || verdicts.length === 0) return '';
  const unfaithful = verdicts.filter(
    (v: { verdict: number }) => v.verdict === 0,
  ) as Array<{ statement: string; reason: string }>;
  if (unfaithful.length === 0) return 'All statements are faithful to the context.';
  return unfaithful
    .map((v) => `"${v.statement}" — ${v.reason}`)
    .join('; ');
}

export async function runHallucination(input: string, output: string, groundingContext: string): Promise<EvalResult> {
  const combinedContext = `${input}\n\n${groundingContext}`;
  const result = await Faithfulness({
    input,
    output,
    context: combinedContext,
    model: EVAL_MODEL,
  });

  const score = result.score ?? 0;
  return {
    name: 'Hallucination',
    score,
    label: scoreToHallucinationLabel(score),
    explanation: summarizeFaithfulness(result.metadata),
  };
}
