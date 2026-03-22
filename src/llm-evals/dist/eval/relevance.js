"use strict";
/**
 * Relevance (topic drift) scorer: does the response address what the user asked,
 * or has it drifted off-topic?
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runRelevance = runRelevance;
const autoevals_1 = require("autoevals");
const shared_js_1 = require("./shared.js");
const RelevanceClassifier = (0, autoevals_1.LLMClassifierFromTemplate)({
    name: 'Relevance',
    promptTemplate: `You are an evaluation judge. Assess whether the assistant's response is relevant and on-topic given the customer's question.

<customer_question>
{{input}}
</customer_question>

<assistant_response>
{{output}}
</assistant_response>

Evaluate whether the response directly addresses what the customer asked. Flag any drift into unrelated topics or unnecessary tangents.`,
    choiceScores: {
        'Perfectly relevant — every part of the response directly addresses the question': 1.0,
        'Mostly relevant — on-topic with minor tangential content': 0.75,
        'Partially relevant — addresses the question but with significant drift': 0.5,
        'Marginally relevant — loosely related but largely misses the point': 0.25,
        'Not relevant — the response is off-topic or ignores the question entirely': 0.0,
    },
    useCoT: true,
    model: shared_js_1.EVAL_MODEL,
});
async function runRelevance(input, output) {
    const result = await RelevanceClassifier({
        input,
        output,
    });
    const score = result.score ?? 0;
    return {
        name: 'Relevance',
        score,
        label: String(result.metadata?.choice ?? ''),
        explanation: String(result.metadata?.rationale ?? result.metadata?.choice ?? ''),
    };
}
