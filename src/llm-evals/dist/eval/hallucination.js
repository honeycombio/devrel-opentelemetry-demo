"use strict";
/**
 * Hallucination scorer: are claims in the response fabricated (not from the provided context)?
 * Uses Faithfulness with context = user question + grounding context combined.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runHallucination = runHallucination;
const autoevals_1 = require("autoevals");
const shared_js_1 = require("./shared.js");
function scoreToHallucinationLabel(score) {
    if (score >= 0.8)
        return 'no_hallucination';
    if (score >= 0.5)
        return 'minor_hallucination';
    return 'hallucinated';
}
function summarizeFaithfulness(metadata) {
    const verdicts = metadata?.faithfulness;
    if (!Array.isArray(verdicts) || verdicts.length === 0)
        return '';
    const unfaithful = verdicts.filter((v) => v.verdict === 0);
    if (unfaithful.length === 0)
        return 'All statements are faithful to the context.';
    return unfaithful
        .map((v) => `"${v.statement}" — ${v.reason}`)
        .join('; ');
}
async function runHallucination(input, output, groundingContext) {
    const combinedContext = `${input}\n\n${groundingContext}`;
    const result = await (0, autoevals_1.Faithfulness)({
        input,
        output,
        context: combinedContext,
        model: shared_js_1.EVAL_MODEL,
    });
    const score = result.score ?? 0;
    return {
        name: 'Hallucination',
        score,
        label: scoreToHallucinationLabel(score),
        explanation: summarizeFaithfulness(result.metadata),
    };
}
