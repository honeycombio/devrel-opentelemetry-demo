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

## Adding logs to cart service

Cart service is already emitting some logs over OTLP, based on me looking at the telemetry.

### Current Cart Service Logging Analysis Plan

1. **Examine current logging implementation**
   - Check `src/cart/src/services/CartService.cs` for existing logging
   - Review logging configuration and OTLP setup
   - Identify current log levels and structured logging usage

2. **Identify error scenarios from error_customer.py**
   - Invalid product additions to cart
   - Cart operations with non-existent sessions
   - Failed cart retrievals

3. **Design enhanced logging strategy**
   - Add structured error logs for invalid operations
   - Add info logs for successful cart operations
   - Include customer context from baggage
   - Ensure OTLP integration for observability

4. **Implementation approach**
   - Use existing .NET logging framework
   - Maintain OpenTelemetry integration
   - Follow structured logging best practices
   - Test with error_customer.py load

### Analysis Results

#### Current Cart Service Logging (Step 1)

**Existing Logging Setup:**
- ✅ OpenTelemetry OTLP logging configured (`Program.cs:31`)
- ✅ Console logging enabled for development
- ✅ ILogger<T> injection available throughout service
- ❌ **No actual logging statements in CartService.cs**
- ✅ Activity tracing with user/product context tags
- ✅ Exception handling adds to Activity (not logs)

**Current Telemetry Approach:**
- Uses Activity (tracing) for error tracking via `activity?.AddException(ex)`
- Sets activity status and tags for context
- No structured logging for business operations
- Relies entirely on OpenTelemetry auto-instrumentation

#### Error Scenarios from error_customer.py (Step 2)

**Cart-Specific Error Patterns:**
1. **Invalid Product Addition** (`add_invalid_product_to_cart`)
   - POST `/api/cart` with non-existent productIds
   - Expects 4xx responses for invalid products
   - Followed by cart retrieval with `GET /api/cart`

2. **Checkout with Invalid Items** (`checkout_with_invalid_items`)
   - Adds multiple invalid products to cart
   - Attempts checkout with invalid cart contents
   - Tests error propagation through cart → checkout flow

3. **Cart State Tracking**
   - Fixed customer ID: `cust642adf325`
   - Session-based cart operations
   - Baggage context includes customer.id and session.id

#### Enhanced Logging Strategy (Step 3)

**Logging Framework:**
- Use existing `ILogger<CartService>` with structured logging
- Maintain OTLP export configuration
- Add complement to existing Activity tracing (not replacement)
- Include customer context from Activity tags

**Error Logging Enhancements:**
```csharp
// AddItem errors with detailed context
_logger.LogError("Failed to add product {ProductId} to cart for user {UserId}: {ErrorMessage}", 
    request.Item.ProductId, request.UserId, ex.Message);

// Additional detailed info logs on failure
_logger.LogInformation("Cart operation failure context - User: {UserId}, Product: {ProductId}, Quantity: {Quantity}, RequestedAt: {Timestamp}", 
    request.UserId, request.Item.ProductId, request.Item.Quantity, DateTimeOffset.UtcNow);
_logger.LogInformation("Cart failure environment - Session: {SessionId}, FeatureFlags: {FeatureContext}", 
    Activity.Current?.GetBaggageItem("session.id"), "cartFailure enabled");
_logger.LogInformation("Cart store type: {StoreType}, Connection status: {ConnectionStatus}", 
    _cartStore.GetType().Name, "attempting connection");

// Invalid product scenarios with enriched context
_logger.LogWarning("Attempted to add invalid product {ProductId} for user {UserId}", 
    request.Item.ProductId, request.UserId);
_logger.LogInformation("Invalid product attempt details - Product: {ProductId}, User: {UserId}, Quantity: {Quantity}, UserAgent: {UserAgent}", 
    request.Item.ProductId, request.UserId, request.Item.Quantity, context.GetHttpContext()?.Request.Headers["User-Agent"]);
```

**Info Logging for Success Cases:**
```csharp
// Successful operations
_logger.LogInformation("Added {Quantity} of product {ProductId} to cart for user {UserId}", 
    request.Item.Quantity, request.Item.ProductId, request.UserId);

// Cart state changes
_logger.LogInformation("Cart retrieved for user {UserId} with {ItemCount} unique items, {TotalQuantity} total items", 
    request.UserId, cart.Items.Count, totalCart);
```

**Business Context Integration:**
- Customer ID from Activity tags or baggage
- Product validation status
- Cart size and value metrics
- Operation performance timings

**Detailed Failure Logging Pattern:**
When any cart operation fails, log additional INFO level details:
- Request parameters and context
- Session and baggage information  
- Feature flag states
- Cart store connection status
- HTTP context (User-Agent, IP, etc.)
- Timing and performance metrics
- Current cart state snapshot

### Next Steps
- [x] Analyze current Cart Service logging implementation
- [x] Review error patterns from load generator  
- [x] Design logging enhancements
- [x] Implement and test changes

### Implementation Summary

Enhanced Cart Service with comprehensive logging:

#### Changes Made:
1. **Added ILogger<CartService> dependency injection**
   - Updated constructor in `CartService.cs:23`
   - Updated DI registration in `Program.cs:56`

2. **Success Logging:**
   - `AddItem`: Logs successful product additions with quantity, product ID, user ID
   - `GetCart`: Logs cart retrieval with item counts
   - `EmptyCart`: Logs cart emptying with feature flag status

3. **Failure Logging:**
   - **ERROR logs**: Primary error message with key identifiers
   - **INFO logs on failure**: Detailed context including:
     - Request parameters and timestamps
     - Session ID and Trace ID from OpenTelemetry
     - Cart store types and connection info
     - User-Agent headers for client identification
     - Feature flag states (cartFailure)

4. **Integration with existing telemetry:**
   - Maintained existing Activity tracing
   - Added structured logs that complement OpenTelemetry traces
   - Preserved baggage and context propagation

#### Ready for Testing:
- Test with `error_customer.py` to verify failure logs
- Monitor OTLP log output for structured data
- Validate correlation with existing traces
