# Current Task

This file is for active work. Put output and plans here.
When you complete an item, check it off here and then make a commit.

## what are we working on?

Earlier we worked on src/load-generator/error_customer.py

This file generates some failure load on my demo app when I run it locally.
Next, I need that program to _not_ participate in tracing, and instead, other services in this demo need to output more error and info logs.

## Next thing

[x] remove tracing from error_customer.py (continue to log)
[x] do not implement tracing at all, nor add any tracing instrumentation

[] Make a plan to add error and info logs to the various services accessed by this error load. Put the plan here:

## Plan: Add Error and Info Logs to Demo Services

### Services Overview & Error Patterns from `error_customer.py`

The error load generator targets these endpoints with specific error patterns:

- **Invalid product IDs** → Product Catalog Service (Go)
- **Invalid cart operations** → Cart Service (C#)
- **Invalid recommendations** → Recommendation Service (Python)
- **Failed checkouts** → Checkout Service (Go) + Frontend (TypeScript)

### High Priority Services for Logging Enhancement

#### 1. Product Catalog Service (`src/product-catalog/main.go`)

**Language:** Go
**Current State:** Has basic gRPC error handling
**Enhancements Needed:**

- Add structured error logs for invalid product ID requests
- Add info logs for successful product lookups
- Include customer context from baggage
- Log search patterns and performance metrics

#### 2. Cart Service (`src/cart/src/services/CartService.cs`)

**Language:** C#/.NET
**Current State:** Basic cart operations with Valkey/Redis
**Enhancements Needed:**

- Error logs for invalid product additions
- Info logs for successful cart operations
- Log cart state changes and session tracking
- Include customer ID in all cart operations

#### 3. Recommendation Service (`src/recommendation/recommendation_server.py`)

**Language:** Python
**Current State:** Basic recommendation logic
**Enhancements Needed:**

- Error logs for invalid product recommendation requests
- Info logs for successful recommendations
- Log cache hits/misses and performance
- Include customer context for personalization tracking

#### 4. Checkout Service (`src/checkout/main.go`)

**Language:** Go  
**Current State:** Complex orchestration service
**Enhancements Needed:**

- Comprehensive error logging for failed checkout steps
- Info logs for successful order processing
- Log payment failures, shipping issues, inventory problems
- Track customer journey through checkout funnel

#### 5. Frontend Service (`src/frontend/pages/api/`)

**Language:** TypeScript/Next.js
**Current State:** API gateway with basic error handling  
**Enhancements Needed:**

- Request/response logging for all API endpoints
- Error logs for gRPC communication failures
- Customer session tracking and error correlation
- Performance logging for API response times

### Implementation Strategy

1. **Start with Product Catalog** - Simplest service, handles most direct errors --- except, we learned that it didn't work as documented.
2. **Move to Cart Service** - Critical for e-commerce flow -- except, CartService doesn't actually fail for our error flow. The info logs are useful though
3. **Add Recommendation logging** - Good for ML/AI observability patterns -- done, but it doesn't fail either
4. **Enhance Checkout** - Most complex, highest business impact
5. **Complete with Frontend** - Entry point aggregation <- this is the one that sees everything. The payoff is here

### Logging Standards to Implement

- Exports via OpenTelemetry
- integrates with OpenTelemetry tracing, so that it will get trace IDs attached to it by OpenTelemetry
- Use structured logging
- Include customer ID (`app.user.id`)
- Use consistent log levels (ERROR and more detailed INFO for failures, INFO for success)
- Include performance metrics (cache hits)
- Add business context (product IDs, cart values, order status)

## Adding OTLP logs to the frontend

### Current Frontend Logging State Analysis

**Service:** Frontend (TypeScript/Next.js application)
**Location:** `/src/frontend/`

#### Current Logging Implementation

**❌ NO STRUCTURED LOGGING** - The frontend currently has minimal to no logging infrastructure:

1. **No Console Logging**: Search for `console.log|console.error|console.warn|console.info` found no results
2. **No Logging Libraries**: No dedicated logging libraries found in dependencies
3. **No Structured Logging**: No log formatting or structured output
4. **Error Handling Without Logging**: Error handling exists but without logging:
   - `InstrumentationMiddleware.ts` records exceptions to spans but doesn't log them
   - Gateway files use Promise rejection without logging
   - React components have error boundaries but no logging

#### Current OpenTelemetry Setup

**✅ COMPREHENSIVE OTEL TRACING** - Already well-configured:

**Dependencies in `package.json`:**

- `@opentelemetry/api`: 1.9.0
- `@opentelemetry/auto-instrumentations-node`: 0.56.1
- `@opentelemetry/auto-instrumentations-web`: ^0.47.0
- `@opentelemetry/exporter-trace-otlp-grpc`: 0.57.2
- `@opentelemetry/exporter-trace-otlp-http`: ~0.201.1
- `@honeycombio/opentelemetry-web`: ^0.18.0
- All necessary SDK and instrumentation packages

**Server-side Instrumentation (`utils/telemetry/Instrumentation.js`):**

- NodeSDK with OTLP trace exporter
- OTLP metrics exporter
- Auto-instrumentations enabled
- Resource detectors configured

**Client-side Instrumentation (`utils/telemetry/HoneycombFrontendTracer.ts`):**

- HoneycombWebSDK setup
- Web auto-instrumentations
- Fetch and user interaction instrumentation
- Session tracking integration

**Telemetry Infrastructure:**

- `Instrumentation.js`: initializes OpenTelemetry for the services
- `SpanUtils.ts`: Helper functions for tracing operations
- `InstrumentationMiddleware.ts`: API middleware with metrics and error recording
- `SessionIdProcessor.ts`: Session correlation for spans

#### Current Error Handling Patterns

**Spans Record Exceptions** (but no logs):

```typescript
// InstrumentationMiddleware.ts - line 24
span.recordException(error as Exception);
span.setStatus({ code: SpanStatusCode.ERROR });

// SpanUtils.ts - line 62-81
function recordExceptionAndMarkSpanError(err: unknown, span: Span);
```

**Promise-based Error Handling** (no logging):

```typescript
// Gateway pattern example
client.listProducts({}, (error, response) => (error ? reject(error) : resolve(response)));
```

#### API Route Structure

**Files to Enhance with Logging:**

- `/pages/api/cart.ts` - Cart operations
- `/pages/api/checkout.ts` - Order placement
- `/pages/api/currency.ts` - Currency conversion
- `/pages/api/products/index.ts` - Product listing
- `/pages/api/products/[productId]/index.ts` - Product details
- `/pages/api/recommendations.ts` - Product recommendations
- `/pages/api/shipping.ts` - Shipping quotes

All API routes use `InstrumentationMiddleware` for tracing but lack logging.

### Implementation Plan for Frontend Logging

Logging infrastructure has been added and is working.

[x] Add logs with business context to endpoints.
[x] Include the customer ID as `app.user.id` ... this happens to be the same value as session ID in this demo app
[x] On failure, add error logs AND extra info logs. Include the app.user.id in both.

### ✅ COMPLETED: Frontend API Logging Implementation

**Enhanced API Endpoints with Business Context Logging:**

1. **Product Details** (`/api/products/[productId]`)
   - Success: Product info with price, name, customer ID
   - Failure: Error + info log with customer context for invalid product IDs

2. **Cart Operations** (`/api/cart`)
   - GET: Cart metrics (item count, quantities, customer ID)  
   - POST: Item addition tracking with product and quantity details
   - DELETE: Cart empty operations
   - All operations include customer ID and error context on failures

3. **Checkout** (`/api/checkout`)
   - Success: Order tracking with total cost, item count, shipping info
   - Failure: Comprehensive error logging with order attempt details
   - Includes customer ID in all logs

4. **Recommendations** (`/api/recommendations`)
   - Success: Recommendation metrics (input/output counts, product IDs)
   - Failure: Error context with recommendation attempt details
   - Customer ID tracking for personalization context

**Logging Standards Implemented:**
- ✅ Customer ID as `app.user.id` (using session ID)
- ✅ Structured logging with business context
- ✅ Error + additional info logs on failures
- ✅ Consistent field naming (`app.product.id`, `app.cart.*`, `app.order.*`)
- ✅ Integrated with existing OpenTelemetry infrastructure

## Kafka Message Publishing Analysis - Checkout Service

### Key Files Found

1. **`/src/checkout/kafka/producer.go`** - Kafka producer configuration
2. **`/src/checkout/main.go`** - Main service with Kafka publishing logic

### Kafka Producer Configuration

**Location:** `/src/checkout/kafka/producer.go`

**Key Configuration:**
- **Topic:** `"orders"` (line 11)
- **Protocol Version:** `sarama.V3_0_0_0` (line 12)
- **Producer Type:** `sarama.AsyncProducer` (asynchronous)
- **Return Settings:**
  - `Return.Successes = true` (lines 19, 29)
  - `Return.Errors = true` (line 20)
- **Required Acks:** `sarama.NoResponse` (line 24) - **This is important for performance but may swallow failed messages**

**No Explicit Timeout Configuration Found** - Using Sarama defaults

### "orders publish" Span Creation

**Location:** `/src/checkout/main.go`, lines 559-583

The span that shows up in traces as "orders publish" is created by the `createProducerSpan()` function:

```go
func createProducerSpan(ctx context.Context, msg *sarama.ProducerMessage) trace.Span {
    spanContext, span := tracer.Start(
        ctx,
        fmt.Sprintf("%s publish", msg.Topic), // Creates "orders publish"
        trace.WithSpanKind(trace.SpanKindProducer),
        trace.WithAttributes(
            semconv.PeerService("kafka"),
            semconv.NetworkTransportTCP,
            semconv.MessagingSystemKafka,
            semconv.MessagingDestinationName(msg.Topic),
            semconv.MessagingOperationPublish,
            semconv.MessagingKafkaDestinationPartition(int(msg.Partition)),
        ),
    )
    // ... propagation setup
    return span
}
```

### Message Publishing Flow

**Location:** `/src/checkout/main.go`, `sendToPostProcessor()` function (lines 492-557)

**Flow:**
1. **Message Creation:** Order result marshaled to protobuf (lines 493-497)
2. **Span Creation:** Producer span created with topic name (line 505)
3. **Message Send:** Async send via producer input channel (line 511)
4. **Response Handling:** Complex select statement waits for:
   - Success response (lines 514-520)
   - Error response (lines 521-527)
   - Context cancellation (lines 528-534, 536-542)

**Timing:** Start time recorded before send (line 509), duration calculated on completion

**Attributes Set on Success:**
- `messaging.kafka.producer.success: true`
- `messaging.kafka.producer.duration_ms: <duration>`
- `messaging.kafka.message.offset: <offset>`

**Attributes Set on Failure:**
- `messaging.kafka.producer.success: false`
- `messaging.kafka.producer.duration_ms: <duration>`
- Span status set to ERROR with error message

### Potential Timeout Issues

**No explicit timeouts configured for:**
- Kafka producer operations
- Context deadline enforcement
- Message delivery acknowledgment

**The service relies on:**
- Context cancellation from upstream requests
- Sarama library's default timeout behaviors
- `RequiredAcks = NoResponse` setting may mask timeout issues

This explains why the "orders publish" span appears in traces and provides the context for any timeout-related issues we might be investigating.
