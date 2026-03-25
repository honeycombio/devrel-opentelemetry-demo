import { Kafka } from 'kafkajs';
import { evaluateChat } from './eval/index.js';

const KAFKA_ADDR = process.env.KAFKA_ADDR;
if (!KAFKA_ADDR) {
  console.error('KAFKA_ADDR is not set');
  process.exit(1);
}

const kafka = new Kafka({ brokers: [KAFKA_ADDR], clientId: 'llm-evals' });
const consumer = kafka.consumer({ groupId: 'llm-evals' });

async function main() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'llm-evals', fromBeginning: false });
  console.log('LLM Evals consumer connected, waiting for messages on topic "llm-evals"');

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let payload: any;
      try {
        payload = JSON.parse(message.value.toString());
      } catch {
        console.warn('Skipping non-JSON message on llm-evals topic');
        return;
      }
      await evaluateChat(
        payload.traceId,
        payload.spanId,
        payload.input,
        payload.output,
        payload.groundingContext ?? '',
        payload.agentName ?? 'unknown',
        payload.responseModel ?? 'unknown',
        payload.inputTokens ?? 0,
        payload.outputTokens ?? 0,
        payload.ttftMs ?? 0,
      ).catch((err) => {
        console.error('Evaluation failed:', err);
      });
    },
  });
}

main().catch((err) => {
  console.error('Fatal error in llm-evals consumer:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await consumer.disconnect();
});
