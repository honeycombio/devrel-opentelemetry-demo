// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useMutation, MutateOptions } from '@tanstack/react-query';
import ApiGateway from '../gateways/Api.gateway';

export interface AiRequestPayload {
    question: string;
}

export type AiResponse = { text: string; traceId: string; spanId: string; researchModel: string };

interface AiAssistantContextValue {
    aiResponse: AiResponse | null;
    aiLoading: boolean;
    aiError: Error | null;
    feedbackSent: boolean;
    sendAiRequest: (
        payload: AiRequestPayload,
        options?: MutateOptions<AiResponse, Error, AiRequestPayload, unknown>
    ) => void;
    sendFeedback: (traceId: string, spanId: string, sentiment: 1 | -1 | 0) => void;
    reset: () => void;
}

const Context = createContext<AiAssistantContextValue>({
    aiResponse: null,
    aiLoading: false,
    aiError: null,
    feedbackSent: false,
    sendAiRequest: () => {},
    sendFeedback: () => {},
    reset: () => {},
});

export const useAiAssistant = () => useContext(Context);

interface ProductAIAssistantProviderProps {
    children: React.ReactNode;
    productId: string;
}

const ProductAIAssistantProvider = ({ children, productId }: ProductAIAssistantProviderProps) => {
    const [feedbackSent, setFeedbackSent] = useState(false);

    const mutation = useMutation<AiResponse, Error, AiRequestPayload>({
        mutationFn: async ({ question }) => {
            const { answer, traceId, spanId, researchModel } = await ApiGateway.askProductAIAssistant(productId, question);
            return { text: answer, traceId, spanId, researchModel };
        },
    });

    // Clear AI state when switching products.
    useEffect(() => {
        mutation.reset();
        setFeedbackSent(false);
    }, [productId]);

    const sendFeedback = useCallback((traceId: string, spanId: string, sentiment: 1 | -1 | 0) => {
        ApiGateway.sendFeedback(traceId, spanId, sentiment);
        setFeedbackSent(true);
    }, []);

    const value = useMemo(
        () => ({
            aiResponse: mutation.data ?? null,
            aiLoading: mutation.isPending,
            aiError: mutation.error ?? null,
            feedbackSent,
            sendAiRequest: (
                payload: AiRequestPayload,
                options?: MutateOptions<AiResponse, Error, AiRequestPayload, unknown>
            ) => {
                setFeedbackSent(false);
                mutation.mutate(payload, options);
            },
            sendFeedback,
            reset: () => {
                mutation.reset();
                setFeedbackSent(false);
            },
        }),
        [mutation.data, mutation.isPending, mutation.error, feedbackSent, sendFeedback]
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
};

export default ProductAIAssistantProvider;
