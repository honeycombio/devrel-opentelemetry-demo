"use strict";
/**
 * Bias scorer: custom LLM classifier detecting assumptions about customer needs,
 * product/platform favoritism, dismissive tone, and skewed framing.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBias = runBias;
const autoevals_1 = require("autoevals");
const shared_js_1 = require("./shared.js");
const BiasClassifier = (0, autoevals_1.LLMClassifierFromTemplate)({
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
    model: shared_js_1.EVAL_MODEL,
});
async function runBias(input, output) {
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
