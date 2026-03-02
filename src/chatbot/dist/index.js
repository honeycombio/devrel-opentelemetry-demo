"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const app = (0, express_1.default)();
app.use(express_1.default.json());
const PORT = parseInt(process.env.CHATBOT_PORT || '8087', 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
let demoEnabled = false;
function isChatbotAvailable() {
    return demoEnabled && !!ANTHROPIC_API_KEY;
}
// POST /chat/question
app.post('/chat/question', (req, res) => {
    if (!isChatbotAvailable()) {
        res.json({ answer: 'The Chatbot is Unavailable' });
        return;
    }
    // Phase 3 will add the agent orchestration flow here.
    // For now, return a placeholder when enabled.
    const { question, productId } = req.body;
    res.json({ answer: 'The Chatbot is Unavailable' });
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
