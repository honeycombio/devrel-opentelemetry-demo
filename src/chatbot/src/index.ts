import express, { Request, Response } from 'express';
import { trace } from '@opentelemetry/api';
import { handleQuestion } from './agents';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.CHATBOT_PORT || '8087', 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

let demoEnabled = false;

function isChatbotAvailable(): boolean {
  return demoEnabled && !!ANTHROPIC_API_KEY;
}

// POST /chat/question
app.post('/chat/question', async (req: Request, res: Response) => {
  const span = trace.getActiveSpan();
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
    const answer = await handleQuestion(question, productId);
    res.json({ answer });
  } catch {
    span?.setAttribute('chatbot.result', 'error');
    res.json({ answer: 'The Chatbot is Unavailable' });
  }
});

// POST /chat/demo-enable
app.post('/chat/demo-enable', (_req: Request, res: Response) => {
  demoEnabled = true;
  res.json({ status: 'enabled' });
});

// POST /chat/demo-disable
app.post('/chat/demo-disable', (_req: Request, res: Response) => {
  demoEnabled = false;
  res.json({ status: 'disabled' });
});

app.listen(PORT, () => {
  console.log(`Chatbot service listening on port ${PORT}`);
});
