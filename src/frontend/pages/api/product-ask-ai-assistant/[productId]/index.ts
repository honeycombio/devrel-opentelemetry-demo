// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../../../utils/telemetry/InstrumentationMiddleware';
import { context, propagation } from '@opentelemetry/api';

type TResponse = string | { text: string } | '';

const CHATBOT_ADDR = process.env.CHATBOT_ADDR || '';

const handler = async ({ method, body, query }: NextApiRequest, res: NextApiResponse<TResponse>) => {
    switch (method) {
        case 'POST': {
            const { productId = '' } = query;
            const { question } = body;

            if (!CHATBOT_ADDR) {
                return res.status(200).json('The Chatbot is Unavailable');
            }

            // Inject trace context headers for propagation to chatbot
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            propagation.inject(context.active(), headers);

            const chatbotResponse = await fetch(`${CHATBOT_ADDR}/chat/question`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ question, productId }),
            });

            if (!chatbotResponse.ok) {
                return res.status(200).json('The Chatbot is Unavailable');
            }

            const { answer } = await chatbotResponse.json();
            return res.status(200).json(answer ?? 'The Chatbot is Unavailable');
        }

        default: {
            return res.status(405).send('');
        }
    }
};

export default InstrumentationMiddleware(handler);
