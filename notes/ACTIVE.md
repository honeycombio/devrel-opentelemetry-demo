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

1. **Start with Product Catalog** - Simplest service, handles most direct errors
2. **Move to Cart Service** - Critical for e-commerce flow
3. **Add Recommendation logging** - Good for ML/AI observability patterns
4. **Enhance Checkout** - Most complex, highest business impact
5. **Complete with Frontend** - Entry point aggregation

### Logging Standards to Implement

- Exports via OpenTelemetry
- integrates with OpenTelemetry tracing, so that it will get trace IDs attached to it by OpenTelemetry
- Use structured logging
- Include customer ID (`app.user.id`) from baggage context
- Use consistent log levels (ERROR and more detailed INFO for failures, INFO for success)
- Include performance metrics (cache hits)
- Add business context (product IDs, cart values, order status)

## Current step: Product Catalog

Answer these questions:

- what logging is currently in use in the service?

**Current logging in Product Catalog Service:**
- Uses Go's standard `log` package with basic `log.Printf()` calls
- Simple text-based logging to stdout/stderr
- No structured logging (not JSON format)
- Basic error logging for gRPC operations
- No OpenTelemetry integration for logs
- Examples from the code:
  ```go
  log.Printf("ProductCatalog gRPC server listening on port %s", port)
  log.Printf("failed to read product catalog")
  ```

- what logging tool can you use, that integrates with OpenTelemetry? Research on the internet.

**Go Logging Libraries with OpenTelemetry Integration:**

1. **logrus with otellogrus** - Most popular structured logging library for Go
   - Package: `github.com/sirupsen/logrus` + `go.opentelemetry.io/contrib/bridges/otellogrus`
   - Features: JSON formatting, hooks for OTel integration, widespread adoption
   - Best for: Production applications requiring structured logging

2. **slog (Go 1.21+) with otelslog** - Official Go structured logging
   - Package: `log/slog` (standard library) + `go.opentelemetry.io/contrib/bridges/otelslog` 
   - Features: Built into Go standard library, high performance, official OTel bridge
   - Best for: Modern Go applications (Go 1.21+), official support

3. **zap with otelzap** - Uber's high-performance logging library
   - Package: `go.uber.org/zap` + `go.opentelemetry.io/contrib/bridges/otelzap`
   - Features: Extremely fast, structured logging, comprehensive OTel integration
   - Best for: High-throughput applications requiring maximum performance

4. **zerolog with otelzerolog** - Zero allocation JSON logger
   - Package: `github.com/rs/zerolog` + OpenTelemetry bridge
   - Features: Zero allocation, fast JSON logging, minimal memory footprint
   - Best for: Performance-critical applications

**Recommendation for Product Catalog:**
Use **slog with otelslog** because:
- It's the official Go structured logging solution (Go 1.21+)
- Has official OpenTelemetry bridge support
- Provides structured JSON logging out of the box
- Minimal dependencies (mostly standard library)
- Future-proof as it's the Go team's recommended approach
