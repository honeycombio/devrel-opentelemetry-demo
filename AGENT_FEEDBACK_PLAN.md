# User Feedback on Chatbot Responses

## Context
The chatbot service answers product questions. We want to collect thumbs up/down feedback and record it as a span on the **same trace** that handled the original question, so feedback appears in Honeycomb alongside the agent spans.

## Files to Modify

1. **`src/chatbot/src/agents.ts`** — Return trace context from `handleQuestion`
2. **`src/chatbot/src/index.ts`** — Update `/chat/question` response; add `POST /chat/feedback` endpoint
3. **`src/frontend/gateways/Api.gateway.ts`** — Update `askProductAIAssistant` return type; add `sendFeedback` method
4. **`src/frontend/providers/ProductAIAssistant.provider.tsx`** — Track trace context; expose `sendFeedback`; track feedback state
5. **`src/frontend/components/ProductReviews/ProductReviews.tsx`** — Render thumbs up/down after answer; reset to input after feedback
6. **`src/frontend/components/ProductReviews/ProductReviews.styled.ts`** — Add styled components for feedback buttons

## Implementation Steps

### Step 1: Backend — Return trace context from `handleQuestion`

In `agents.ts`, change `handleQuestion` to return `{ answer, traceId, spanId }` instead of just a string.

- Extract `span.spanContext().traceId` and `span.spanContext().spanId` from the supervisor span
- Return an object: `{ answer: string, traceId: string, spanId: string }`

### Step 2: Backend — Update `/chat/question` and add `/chat/feedback`

In `index.ts`:

**Update `/chat/question`:**
- Change `res.json({ answer })` to `res.json({ answer, traceId, spanId })` using the object returned from `handleQuestion`

**Add `POST /chat/feedback`:**
- Accepts `{ traceId, spanId, sentiment: "good" | "bad" }`
- Creates a remote span context from the provided `traceId` and `spanId`
- Starts a new child span under that context with name `"user_feedback"`
- Sets attributes: `feedback.sentiment`, `feedback.trace_id`
- Ends the span immediately
- Returns `{ status: "ok" }`

Key OTel API usage:
```ts
import { trace, context, SpanContext, TraceFlags } from '@opentelemetry/api';

const remoteContext: SpanContext = {
  traceId,
  spanId,
  traceFlags: TraceFlags.SAMPLED,
  isRemote: true,
};
const parentContext = trace.setSpanContext(context.active(), remoteContext);
const tracer = trace.getTracer('chatbot');
tracer.startActiveSpan('user_feedback', {}, parentContext, (span) => {
  span.setAttribute('feedback.sentiment', sentiment);
  span.end();
});
```

### Step 3: Frontend — Update API gateway

In `Api.gateway.ts`:

- Change `askProductAIAssistant` to return `{ answer: string, traceId: string, spanId: string }` (the full response object instead of just `answer`)
- Add `sendFeedback(traceId: string, spanId: string, sentiment: "good" | "bad")` method that POSTs to `/chat/feedback`

### Step 4: Frontend — Update provider

In `ProductAIAssistant.provider.tsx`:

- Change `AiResponse` type to include `traceId` and `spanId` fields: `{ text: string, traceId: string, spanId: string }`
- Add `sendFeedback` to context value — calls `ApiGateway.sendFeedback`
- Add `feedbackSent: boolean` state to track whether feedback was submitted
- Expose `feedbackSent` in context so the component knows to show input vs feedback buttons

### Step 5: Frontend — Thumbs up/down UI

In `ProductReviews.tsx`:

- When `aiResponse` exists and `feedbackSent` is false: show thumbs up/down buttons alongside the answer
- On click: call `sendFeedback(aiResponse.traceId, aiResponse.spanId, "good" | "bad")`
- When `feedbackSent` is true: show "Thanks for your feedback!" briefly, then reset back to the question input
- When question is out of scope ("Sorry, I'm not able to answer") or error: do NOT show feedback buttons (per spec failure conditions)

### Step 6: Frontend — Styled components

In `ProductReviews.styled.ts`:

- Add `FeedbackRow` — flex container for the two buttons
- Add `FeedbackButton` — styled button for thumbs up/down (reuse `AskAIButton` styling pattern)

## Verification

1. Run the chatbot service and frontend
2. Ask an in-scope product question — verify response includes `traceId` and `spanId`
3. Click thumbs up or thumbs down — verify feedback POST succeeds
4. In Honeycomb, find the trace — verify `user_feedback` span appears as a child of the supervisor span
5. Verify out-of-scope questions do NOT show feedback buttons
6. Verify after feedback, UI resets to the question input
