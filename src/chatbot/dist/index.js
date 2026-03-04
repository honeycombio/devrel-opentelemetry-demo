"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const api_1 = require("@opentelemetry/api");
const agents_1 = require("./agents");
const app = (0, express_1.default)();
app.use(express_1.default.json());
const PORT = parseInt(process.env.CHATBOT_PORT || '8087', 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
let demoEnabled = false;
function isChatbotAvailable() {
    return demoEnabled && !!ANTHROPIC_API_KEY;
}
// POST /chat/question
app.post('/chat/question', async (req, res) => {
    const span = api_1.trace.getActiveSpan();
    const available = isChatbotAvailable();
    span?.setAttribute('chatbot.demo_enabled', demoEnabled);
    span?.setAttribute('chatbot.available', available);
    if (!available) {
        span?.setAttribute('chatbot.result', 'unavailable');
        res.json({ answer: 'The Chatbot is Unavailable' });
        return;
    }
    const { question, productId } = req.body;
    span?.setAttribute('chatbot.question', question ?? '');
    if (productId) {
        span?.setAttribute('chatbot.product_id', productId);
    }
    if (!question || typeof question !== 'string') {
        span?.setAttribute('chatbot.result', 'invalid_input');
        res.json({ answer: 'Please provide a question.' });
        return;
    }
    try {
        const { answer, traceId, spanId } = await (0, agents_1.handleQuestion)(question, productId);
        res.json({ answer, traceId, spanId });
    }
    catch {
        span?.setAttribute('chatbot.result', 'error');
        res.json({ answer: 'The Chatbot is Unavailable' });
    }
});
// POST /chat/feedback
app.post('/chat/feedback', (req, res) => {
    const { traceId, spanId, sentiment } = req.body;
    if (!traceId || !spanId || !['good', 'bad'].includes(sentiment)) {
        res.status(400).json({ error: 'Invalid feedback payload' });
        return;
    }
    const remoteContext = {
        traceId,
        spanId,
        traceFlags: api_1.TraceFlags.SAMPLED,
        isRemote: true,
    };
    const parentContext = api_1.trace.setSpanContext(api_1.context.active(), remoteContext);
    const tracer = api_1.trace.getTracer('chatbot');
    tracer.startActiveSpan('user_feedback', {}, parentContext, (feedbackSpan) => {
        feedbackSpan.setAttribute('feedback.sentiment', sentiment);
        feedbackSpan.setAttribute('feedback.trace_id', traceId);
        feedbackSpan.end();
    });
    res.json({ status: 'ok' });
});
// POST /chat/demo-enable
app.post('/chat/demo-enable', (_req, res) => {
    demoEnabled = true;
    res.json({ status: 'enabled' });
});
// POST /chat/demo-disable
app.post('/chat/demo-disable', (_req, res) => {
    demoEnabled = false;
    res.json({ status: 'disabled' });
});
app.listen(PORT, () => {
    console.log(`Chatbot service listening on port ${PORT}`);
});
