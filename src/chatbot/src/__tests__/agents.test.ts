import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mock: Anthropic client ──────────────────────────────────────────
const mockCreate = vi.fn();
vi.mock('../anthropic-client', () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}));

// ── Mock: @opentelemetry/api ────────────────────────────────────────
const mockSpan = {
  spanContext: () => ({ traceId: 'abc123', spanId: 'def456' }),
  setAttribute: vi.fn(),
  addEvent: vi.fn(),
  recordException: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
};

const mockCounterAdd = vi.fn();
const mockHistogramRecord = vi.fn();

const mockStartActiveSpan = vi.fn((_name: string, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan));

vi.mock('@opentelemetry/api', () => ({
  trace: { getTracer: () => ({ startActiveSpan: mockStartActiveSpan }) },
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: mockCounterAdd }),
      createHistogram: () => ({ record: mockHistogramRecord }),
    }),
  },
  propagation: { inject: vi.fn() },
  context: { active: () => ({}) },
  SpanStatusCode: { ERROR: 2 },
}));

// ── Mock: @opentelemetry/semantic-conventions/incubating ─────────────
vi.mock('@opentelemetry/semantic-conventions/incubating', () => {
  const constants: Record<string, string> = {
    ATTR_GEN_AI_AGENT_NAME: 'gen_ai.agent.name',
    ATTR_GEN_AI_OPERATION_NAME: 'gen_ai.operation.name',
    ATTR_GEN_AI_PROVIDER_NAME: 'gen_ai.provider.name',
    ATTR_GEN_AI_REQUEST_MODEL: 'gen_ai.request.model',
    ATTR_GEN_AI_REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
    ATTR_GEN_AI_RESPONSE_MODEL: 'gen_ai.response.model',
    ATTR_GEN_AI_RESPONSE_ID: 'gen_ai.response.id',
    ATTR_GEN_AI_RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
    ATTR_GEN_AI_USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
    ATTR_GEN_AI_USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
    ATTR_GEN_AI_INPUT_MESSAGES: 'gen_ai.input.messages',
    ATTR_GEN_AI_OUTPUT_MESSAGES: 'gen_ai.output.messages',
    ATTR_GEN_AI_SYSTEM_INSTRUCTIONS: 'gen_ai.system_instructions',
    ATTR_GEN_AI_TOKEN_TYPE: 'gen_ai.token.type',
    ATTR_GEN_AI_TOOL_NAME: 'gen_ai.tool.name',
    ATTR_GEN_AI_TOOL_CALL_ID: 'gen_ai.tool_call.id',
    ATTR_GEN_AI_TOOL_CALL_ARGUMENTS: 'gen_ai.tool_call.arguments',
    ATTR_GEN_AI_TOOL_CALL_RESULT: 'gen_ai.tool_call.result',
    GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT: 'invoke_agent',
    GEN_AI_OPERATION_NAME_VALUE_CHAT: 'chat',
    GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL: 'execute_tool',
    GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC: 'anthropic',
    GEN_AI_TOKEN_TYPE_VALUE_INPUT: 'input',
    GEN_AI_TOKEN_TYPE_VALUE_OUTPUT: 'output',
    EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS: 'gen_ai.client.inference.operation.details',
    METRIC_GEN_AI_CLIENT_TOKEN_USAGE: 'gen_ai.client.token.usage',
    METRIC_GEN_AI_CLIENT_OPERATION_DURATION: 'gen_ai.client.operation.duration',
  };
  return constants;
});

// ── Mock: global fetch ──────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Helpers ─────────────────────────────────────────────────────────
function makeLLMResponse(textContent: string, extra?: { tool_use?: unknown }) {
  const content: Array<{ type: string; text?: string; [k: string]: unknown }> = [
    { type: 'text', text: textContent },
  ];
  if (extra?.tool_use) {
    content.push(extra.tool_use as { type: string; [k: string]: unknown });
  }
  return {
    id: 'msg_test',
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'end_turn',
    content,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function makeToolUseResponse(toolId: string, toolName: string, input: Record<string, unknown>) {
  return {
    id: 'msg_test',
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'tool_use',
    content: [
      { type: 'tool_use', id: toolId, name: toolName, input },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

// ── Tests ───────────────────────────────────────────────────────────
describe('handleQuestion', () => {
  let handleQuestion: typeof import('../agents').handleQuestion;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-import to get fresh module with cleared mocks
    const mod = await import('../agents');
    handleQuestion = mod.handleQuestion;
  });

  it('happy path: in-scope question with tool-use flow', async () => {
    // 1. scope classifier → inScope: true
    mockCreate.mockResolvedValueOnce(makeLLMResponse('{"inScope": true}'));
    // 2. product fetcher → tool_use block
    mockCreate.mockResolvedValueOnce(makeToolUseResponse('tool_1', 'fetch_products', {}));
    // 3. fetch() for product data
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ id: '1', name: 'Hat' }]),
    });
    // 4. second chat: Claude summarizes tool result
    mockCreate.mockResolvedValueOnce(makeLLMResponse('Here are the products: Hat'));
    // 5. response generator
    mockCreate.mockResolvedValueOnce(makeLLMResponse('<p>We have a Hat!</p>'));

    const result = await handleQuestion('What products do you have?');

    expect(result.answer).toBe('<p>We have a Hat!</p>');
    expect(result.traceId).toBe('abc123');
    expect(result.spanId).toBe('def456');
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });

  it('out-of-scope question returns sorry message', async () => {
    mockCreate.mockResolvedValueOnce(makeLLMResponse('{"inScope": false}'));

    const result = await handleQuestion('What is the weather?');

    expect(result.answer).toContain("Sorry, I'm not able to answer that question");
    // No further LLM calls after scope classifier
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('LLM error returns unavailable message', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API down'));

    const result = await handleQuestion('Tell me about products');

    expect(result.answer).toBe('The Chatbot is Unavailable');
  });

  it('non-JSON scope response treated as out-of-scope', async () => {
    mockCreate.mockResolvedValueOnce(makeLLMResponse('I am not sure what you mean'));

    const result = await handleQuestion('asdfghjkl');

    expect(result.answer).toContain("Sorry, I'm not able to answer that question");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('product fetcher falls back to direct fetch when no tool_use block', async () => {
    // scope classifier → in scope
    mockCreate.mockResolvedValueOnce(makeLLMResponse('{"inScope": true}'));
    // product fetcher returns text only (no tool_use)
    mockCreate.mockResolvedValueOnce(makeLLMResponse('Let me get the products for you.'));
    // fallback fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ id: '1', name: 'Shoe' }]),
    });
    // response generator
    mockCreate.mockResolvedValueOnce(makeLLMResponse('<p>We have Shoes!</p>'));

    const result = await handleQuestion('Show me shoes');

    expect(result.answer).toBe('<p>We have Shoes!</p>');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetch failure returns unable to fetch message', async () => {
    // scope classifier → in scope
    mockCreate.mockResolvedValueOnce(makeLLMResponse('{"inScope": true}'));
    // product fetcher → tool_use
    mockCreate.mockResolvedValueOnce(makeToolUseResponse('tool_1', 'fetch_products', {}));
    // fetch returns 500
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    // second chat after tool result (gets "Unable to fetch" as tool result)
    mockCreate.mockResolvedValueOnce(makeLLMResponse('Unable to fetch product information.'));
    // response generator still called with the "unable" text
    mockCreate.mockResolvedValueOnce(makeLLMResponse('<p>Sorry, unable to get products.</p>'));

    const result = await handleQuestion('What do you sell?');

    // The response generator gets called with the error text
    expect(result.answer).toBeDefined();
  });

  describe('telemetry verification', () => {
    beforeEach(async () => {
      // Set up a full happy-path flow for telemetry checks
      mockCreate.mockResolvedValueOnce(makeLLMResponse('{"inScope": true}'));
      mockCreate.mockResolvedValueOnce(makeToolUseResponse('tool_1', 'fetch_products', {}));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ id: '1', name: 'Hat' }]),
      });
      mockCreate.mockResolvedValueOnce(makeLLMResponse('Products: Hat'));
      mockCreate.mockResolvedValueOnce(makeLLMResponse('<p>Hat</p>'));

      await handleQuestion('What products?');
    });

    it('creates spans with correct names', () => {
      const spanNames = mockStartActiveSpan.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(spanNames).toContain('invoke_agent supervisor');
      expect(spanNames).toContain('invoke_agent scope_classifier');
      expect(spanNames).toContain('chat claude-haiku-4-5-20251001');
      expect(spanNames).toContain('invoke_agent product_fetcher');
      expect(spanNames).toContain('execute_tool fetch_products');
      expect(spanNames).toContain('invoke_agent response_generator');
    });

    it('records token usage metrics', () => {
      expect(mockCounterAdd).toHaveBeenCalled();
      // Each LLM call records input + output tokens (2 calls per LLM invocation)
      const inputCalls = (mockCounterAdd as Mock).mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.['gen_ai.token.type'] === 'input'
      );
      const outputCalls = (mockCounterAdd as Mock).mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.['gen_ai.token.type'] === 'output'
      );
      expect(inputCalls.length).toBeGreaterThan(0);
      expect(outputCalls.length).toBeGreaterThan(0);
    });

    it('emits inference events on spans', () => {
      expect(mockSpan.addEvent).toHaveBeenCalledWith(
        'gen_ai.client.inference.operation.details',
        expect.objectContaining({
          'gen_ai.system_instructions': expect.any(String),
          'gen_ai.input.messages': expect.any(String),
          'gen_ai.output.messages': expect.any(String),
        })
      );
    });
  });
});
