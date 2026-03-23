"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const kafkajs_1 = require("kafkajs");
const index_js_1 = require("./eval/index.js");
const KAFKA_ADDR = process.env.KAFKA_ADDR;
if (!KAFKA_ADDR) {
    console.error('KAFKA_ADDR is not set');
    process.exit(1);
}
const kafka = new kafkajs_1.Kafka({ brokers: [KAFKA_ADDR], clientId: 'llm-evals' });
const consumer = kafka.consumer({ groupId: 'llm-evals' });
async function main() {
    await consumer.connect();
    await consumer.subscribe({ topic: 'llm-evals', fromBeginning: false });
    console.log('LLM Evals consumer connected, waiting for messages on topic "llm-evals"');
    await consumer.run({
        eachMessage: async ({ message }) => {
            if (!message.value)
                return;
            const payload = JSON.parse(message.value.toString());
            await (0, index_js_1.evaluateChat)(payload.traceId, payload.spanId, payload.input, payload.output, payload.groundingContext ?? '', payload.agentName ?? 'unknown', payload.responseModel ?? 'unknown', payload.inputTokens ?? 0, payload.outputTokens ?? 0, payload.ttftMs ?? 0).catch((err) => {
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
