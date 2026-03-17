import express, { Request, Response } from 'express';
import { OpenFeature } from '@openfeature/server-sdk';
import { FlagdProvider } from '@openfeature/flagd-provider';
import { evaluateChat } from './eval/index.js';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.LLM_EVALS_PORT || '8088', 10);

// Initialize OpenFeature with FlagD provider
const flagProvider = new FlagdProvider();
OpenFeature.setProviderAndWait(flagProvider).catch((err) => {
  console.error('Failed to initialize FlagD provider:', err);
});
const featureClient = OpenFeature.getClient();

let evalsDisabledByStartup = false;

/**
 * Startup check: if llm.performEvals is enabled but OPENAI_API_KEY is missing,
 * log a warning and disable evals for the process lifetime.
 */
async function checkEvalsStartup(): Promise<void> {
  const evalsEnabled = await featureClient.getBooleanValue('llm.performEvals', false);
  if (evalsEnabled && !process.env.OPENAI_API_KEY) {
    console.warn(
      'WARNING: llm.performEvals is enabled but OPENAI_API_KEY is not set. Evaluations will be disabled.',
    );
    evalsDisabledByStartup = true;
  }
}

// POST /api/evals
app.post('/api/evals', async (req: Request, res: Response) => {
  if (evalsDisabledByStartup) {
    res.json({ status: 'disabled_at_startup' });
    return;
  }

  const evalsEnabled = await featureClient.getBooleanValue('llm.performEvals', false);
  if (!evalsEnabled) {
    res.json({ status: 'skipped' });
    return;
  }

  const { traceId, spanId, input, output, groundingContext, agentName } = req.body;

  if (!traceId || !spanId || !input || !output) {
    res.status(400).json({ error: 'Missing required fields: traceId, spanId, input, output' });
    return;
  }

  // Respond immediately, run evals in the background
  res.status(202).json({ status: 'queued' });

  evaluateChat(
    traceId,
    spanId,
    input,
    output,
    groundingContext || '',
    agentName || 'unknown',
  ).catch((error) => {
    console.error('Evaluation failed:', error);
  });
});

// Health check
app.get('/api/evals/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', evalsDisabledByStartup });
});

checkEvalsStartup().then(() => {
  app.listen(PORT, () => {
    console.log(`LLM Evals service listening on port ${PORT}`);
  });
});
