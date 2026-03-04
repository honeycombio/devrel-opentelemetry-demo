export interface HandleQuestionResult {
    answer: string;
    traceId: string;
    spanId: string;
}
export declare function handleQuestion(question: string, productId?: string): Promise<HandleQuestionResult>;
