import express, { Request, Response } from 'express';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.CHATBOT_PORT || '8087', 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

let demoEnabled = false;

function isChatbotAvailable(): boolean {
  return demoEnabled && !!ANTHROPIC_API_KEY;
}

// POST /chat/question
app.post('/chat/question', (req: Request, res: Response) => {
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
