import express, { Request, Response } from 'express';
import { trace, context, SpanContext, TraceFlags } from '@opentelemetry/api';
import { OpenFeature } from '@openfeature/server-sdk';
import { FlagdProvider } from '@openfeature/flagd-provider';
import { handleQuestion } from './agents';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.CHATBOT_PORT || '8087', 10);
const HAS_LLM_KEY = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.AWS_REGION);

let demoEnabled = false;

// Initialize OpenFeature with FlagD provider
const flagProvider = new FlagdProvider();
OpenFeature.setProviderAndWait(flagProvider).catch((err) => {
  console.error('Failed to initialize FlagD provider:', err);
});
const featureClient = OpenFeature.getClient();

async function isChatbotAvailable(): Promise<boolean> {
  if (!HAS_LLM_KEY) return false;
  const chatbotEnabledFlag = await featureClient.getBooleanValue('chatbot.enabled', false);
  return chatbotEnabledFlag || demoEnabled;
}

// POST /chat/question
app.post('/chat/question', async (req: Request, res: Response) => {
  const span = trace.getActiveSpan();
  const chatbotEnabledFlag = await featureClient.getBooleanValue('chatbot.enabled', false);
  const available = await isChatbotAvailable();
  span?.setAttribute('chatbot.flag_enabled', chatbotEnabledFlag);
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
    const { answer, traceId, spanId, requestModel, responseModel, totalInputTokens, totalOutputTokens } = await handleQuestion(question, productId);
    res.json({ answer, traceId, spanId, requestModel, responseModel, totalInputTokens, totalOutputTokens });
  } catch {
    span?.setAttribute('chatbot.result', 'error');
    res.json({ answer: 'The Chatbot is Unavailable' });
  }
});

// POST /chat/feedback
app.post('/chat/feedback', (req: Request, res: Response) => {
  const { traceId, spanId, sentiment, requestModel, responseModel, totalInputTokens, totalOutputTokens } = req.body;

  if (!traceId || !spanId || ![1, -1, 0].includes(sentiment)) {
    res.status(400).json({ error: 'Invalid feedback payload' });
    return;
  }

  const remoteContext: SpanContext = {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
  const parentContext = trace.setSpanContext(context.active(), remoteContext);
  const tracer = trace.getTracer('chatbot');
  tracer.startActiveSpan('user-feedback', {}, parentContext, (feedbackSpan) => {
    feedbackSpan.setAttribute('feedback.sentiment', sentiment);
    feedbackSpan.setAttribute('feedback.trace_id', traceId);
    if (requestModel) {
      feedbackSpan.setAttribute('gen_ai.request.model', requestModel);
    }
    if (responseModel) {
      feedbackSpan.setAttribute('gen_ai.response.model', responseModel);
    }
    if (typeof totalInputTokens === 'number') {
      feedbackSpan.setAttribute('gen_ai.usage.input_tokens', totalInputTokens);
    }
    if (typeof totalOutputTokens === 'number') {
      feedbackSpan.setAttribute('gen_ai.usage.output_tokens', totalOutputTokens);
    }
    feedbackSpan.end();
  });

  res.json({ status: 'ok' });
});

// POST /chat/added-to-cart
app.post('/chat/added-to-cart', (req: Request, res: Response) => {
  const { traceId, spanId, productId, quantity, requestModel, responseModel, totalInputTokens, totalOutputTokens } = req.body;

  if (!traceId || !spanId) {
    res.status(400).json({ error: 'Invalid added-to-cart payload' });
    return;
  }

  const remoteContext: SpanContext = {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
  const parentContext = trace.setSpanContext(context.active(), remoteContext);
  const tracer = trace.getTracer('chatbot');
  tracer.startActiveSpan('added-to-cart', {}, parentContext, (span) => {
    span.setAttribute('app.product.id', productId);
    span.setAttribute('app.product.qty', quantity);
    if (requestModel) {
      span.setAttribute('gen_ai.request.model', requestModel);
    }
    if (responseModel) {
      span.setAttribute('gen_ai.response.model', responseModel);
    }
    if (typeof totalInputTokens === 'number') {
      span.setAttribute('gen_ai.usage.input_tokens', totalInputTokens);
    }
    if (typeof totalOutputTokens === 'number') {
      span.setAttribute('gen_ai.usage.output_tokens', totalOutputTokens);
    }
    span.end();
  });

  res.json({ status: 'ok' });
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
