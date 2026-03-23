"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const server_sdk_1 = require("@openfeature/server-sdk");
const flagd_provider_1 = require("@openfeature/flagd-provider");
const index_js_1 = require("./eval/index.js");
const app = (0, express_1.default)();
app.use(express_1.default.json());
const PORT = parseInt(process.env.LLM_EVALS_PORT || '8088', 10);
// Initialize OpenFeature with FlagD provider
const flagProvider = new flagd_provider_1.FlagdProvider();
server_sdk_1.OpenFeature.setProviderAndWait(flagProvider).catch((err) => {
    console.error('Failed to initialize FlagD provider:', err);
});
const featureClient = server_sdk_1.OpenFeature.getClient();
let evalsDisabledByStartup = false;
/**
 * Startup check: if llm.performEvals is enabled but OPENAI_API_KEY is missing,
 * log a warning and disable evals for the process lifetime.
 */
async function checkEvalsStartup() {
    const evalsEnabled = await featureClient.getBooleanValue('llm.performEvals', false);
    if (evalsEnabled && !process.env.OPENAI_API_KEY) {
        console.warn('WARNING: llm.performEvals is enabled but OPENAI_API_KEY is not set. Evaluations will be disabled.');
        evalsDisabledByStartup = true;
    }
}
// POST /api/evals
app.post('/api/evals', async (req, res) => {
    if (evalsDisabledByStartup) {
        res.json({ status: 'disabled_at_startup' });
        return;
    }
    const evalsEnabled = await featureClient.getBooleanValue('llm.performEvals', false);
    if (!evalsEnabled) {
        res.json({ status: 'skipped' });
        return;
    }
    const { traceparent, input, output, groundingContext, agentName } = req.body;
    if (!traceparent || !input || !output) {
        res.status(400).json({ error: 'Missing required fields: traceparent, input, output' });
        return;
    }
    // Process synchronously — the chatbot fires this as fire-and-forget
    try {
        await (0, index_js_1.evaluateChat)(traceparent, input, output, groundingContext || '', agentName || 'unknown');
        res.json({ status: 'ok' });
    }
    catch (error) {
        console.error('Evaluation failed:', error);
        res.status(500).json({ status: 'error', message: String(error) });
    }
});
// Health check
app.get('/api/evals/health', (_req, res) => {
    res.json({ status: 'ok', evalsDisabledByStartup });
});
checkEvalsStartup().then(() => {
    app.listen(PORT, () => {
        console.log(`LLM Evals service listening on port ${PORT}`);
    });
});
