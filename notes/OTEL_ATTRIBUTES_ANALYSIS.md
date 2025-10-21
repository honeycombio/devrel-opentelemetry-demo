# OpenTelemetry Custom Attributes Analysis

## Overview
This document summarizes the custom OpenTelemetry attributes and metrics extracted from all services in the OpenTelemetry Demo application.

## Summary Statistics
- **Total Services Analyzed**: 15 services with custom instrumentation
- **Total Custom Span Attributes**: 50+
- **Total Custom Metrics**: 6
- **Duplicate Attribute Names**: 5 (mostly intentional cross-service attributes)

## Services with Custom Instrumentation

### 1. Ad Service (Java)
**Location**: `src/ad/src/main/java/oteldemo/AdService.java`
**Language**: Java
**Attributes**:
- `app.ads.count` - Number of ads being served
- `app.ads.contextKeys` - List of context keys
- `app.ads.contextKeys.count` - Count of context keys
- `app.ads.ad_request_type` - TARGETED or UNKNOWN
- `app.ads.ad_response_type` - TARGETED or RANDOM
- `app.ads.category` - Category of ads (via @SpanAttribute)
- `session.id` - Session ID from baggage

**Metrics**:
- `app.ads.ad_requests` (counter) - Counts ad requests by type

### 2. Payment Service (Node.js)
**Location**: `src/payment/charge.js`
**Language**: JavaScript
**Attributes**:
- `app.payment.card_type` - visa, mastercard, etc.
- `app.payment.card_valid` - boolean validation result
- `app.loyalty.level` - platinum, gold, silver, bronze
- `app.payment.charged` - Whether payment was charged

**Metrics**:
- `app.payment.transactions` (counter) - Payment transactions with currency attribute

### 3. Currency Service (C++)
**Location**: `src/currency/src/server.cpp`
**Language**: C++
**Attributes**:
- `app.currency.conversion.from` - Source currency code
- `app.currency.conversion.to` - Target currency code

### 4. Shipping Service (Rust)
**Location**: `src/shipping/src/shipping_service.rs` and `src/shipping/src/shipping_service/quote.rs`
**Language**: Rust
**Attributes**:
- `app.shipping.zip_code` - Zip code from address
- `app.shipping.tracking.id` - Generated tracking ID
- `app.shipping.items.count` - Number of items
- `app.shipping.cost.total` - Total shipping cost

### 5. Checkout Service (Go)
**Location**: `src/checkout/main.go`
**Language**: Go
**Attributes**:
- `app.user.id` - User identifier
- `app.user.currency` - User's currency preference
- `app.user.city` - User's city
- `app.order.id` - Order identifier
- `app.order.amount` - Total order amount
- `app.order.items.count` - Number of items in order
- `app.cart.items.count` - Total cart items
- `app.shipping.amount` - Shipping cost
- `messaging.kafka.producer.success` - Kafka send success
- `messaging.kafka.producer.duration_ms` - Kafka operation duration

### 6. Product Catalog Service (Go)
**Location**: `src/product-catalog/main.go`
**Language**: Go
**Attributes**:
- `app.product.id` - Product identifier
- `app.product.name` - Product name
- `app.products.count` - Total products in catalog
- `app.products_search.count` - Search results count

### 7. Quote Service (PHP)
**Location**: `src/quote/app/routes.php`
**Language**: PHP
**Attributes**:
- `app.quote.items.count` - Items in quote
- `app.quote.cost.total` - Total quote cost

**Metrics**:
- `quotes` (counter) - Quotes calculated with number_of_items attribute

### 8. Recommendation Service (Python)
**Location**: `src/recommendation/recommendation_server.py`
**Language**: Python
**Attributes**:
- `app.products_recommended.count` - Number of recommendations
- `app.recommendation.cache_enabled` - Cache enabled flag
- `app.cache_hit` - Cache hit/miss indicator
- `app.products.count` - Total available products
- `app.filtered_products.count` - Filtered product count
- `app.filtered_products.list` - Product ID list

**Metrics**:
- `app_recommendations_counter` (counter) - Recommendations with recommendation.type attribute

### 9. Email Service (Ruby)
**Location**: `src/email/email_server.rb`
**Language**: Ruby
**Attributes**:
- `app.email.recipient` - Email recipient address
- `app.order.id` - Order ID for confirmation

### 10. Frontend Service (TypeScript/Next.js)
**Location**: `src/frontend/utils/telemetry/`
**Language**: TypeScript
**Attributes**:
- `session.id` - User session identifier
- `app.synthetic_request` - Synthetic request flag
- `app.request.method` - HTTP method
- `app.request.target` - Request path
- `app.request.user_agent` - User agent string
- `app.response.status_code` - HTTP status code
- `app.response.duration_ms` - Response duration

**Metrics**:
- `app.frontend.requests` (counter) - Frontend requests with method, target, status

### 11. React Native App (TypeScript)
**Location**: `src/react-native-app/utils/SessionIdProcessor.ts`
**Language**: TypeScript
**Attributes**:
- `session.id` - User session identifier

### 12. Accounting Service (C#)
**Location**: `src/accounting/`
**Language**: C#
**Notes**: Uses auto-instrumentation, no custom attributes found

### 13. Fraud Detection Service (Kotlin)
**Location**: `src/fraud-detection/src/main/kotlin/frauddetection/main.kt`
**Language**: Kotlin
**Notes**: Uses auto-instrumentation with Kafka, no custom attributes found

### 14. Cart Service (C#)
**Location**: `src/cart/src/Program.cs`
**Language**: C#
**Notes**: Uses auto-instrumentation, no custom attributes found

### 15. Image Provider Service
**Location**: `src/image-provider/`
**Notes**: No custom instrumentation found

## Duplicate Attributes (Intentional)

1. **session.id** - Used in Ad Service, Frontend, and React Native App
   - Cross-cutting concern for user session tracking

2. **app.order.id** - Used in Checkout and Email Services
   - Order flows from checkout to email confirmation

3. **app.shipping.amount** - Used in Checkout Service (multiple contexts)
   - Used in both PlaceOrder and PrepareOrderRequest

4. **app.ads.count** - Used in Ad Service (multiple methods)
   - Used in multiple ad retrieval contexts

5. **app.products.count** - Used in Product Catalog and Recommendation Services
   - Similar concept but different contexts (catalog vs recommendations)

## Naming Conventions Observed

### Attribute Naming Patterns
- **Prefix**: `app.` for application-specific attributes
- **Service**: Service name (e.g., `ads`, `payment`, `shipping`)
- **Concept**: What is being measured (e.g., `count`, `id`, `amount`)
- **Modifier**: Additional context (e.g., `.total`, `.from`, `.to`)

### Examples
- `app.ads.count` - Ad service, ads count
- `app.payment.card_type` - Payment service, card type
- `app.shipping.tracking.id` - Shipping service, tracking ID
- `messaging.kafka.producer.success` - Kafka messaging, producer success

### Metric Naming Patterns
- Service-specific counters: `app.ads.ad_requests`, `app.payment.transactions`
- Generic counters: `app.frontend.requests`, `quotes`
- Unit specified in description

## Recommendations

1. **Standardization**: Consider adopting OpenTelemetry semantic conventions more broadly
2. **Documentation**: Keep this registry updated as new attributes are added
3. **Validation**: Implement attribute validation in instrumentation code
4. **Testing**: Add tests to verify custom attributes are set correctly
5. **Monitoring**: Track attribute cardinality to prevent high-cardinality issues

## Registry Location
The complete OpenTelemetry Weaver registry is located at: `src/conventions/registry.yaml`

