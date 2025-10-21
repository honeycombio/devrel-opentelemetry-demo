# OpenTelemetry Custom Attributes - Quick Reference

## By Service

### Ad Service (Java)
```
app.ads.count                    - int    - Number of ads served
app.ads.contextKeys              - string - List of context keys
app.ads.contextKeys.count        - int    - Count of context keys
app.ads.ad_request_type          - string - TARGETED or UNKNOWN
app.ads.ad_response_type         - string - TARGETED or RANDOM
app.ads.category                 - string - Ad category
session.id                       - string - Session ID
```
**Metric**: `app.ads.ad_requests` (counter)

### Payment Service (Node.js)
```
app.payment.card_type            - string - visa, mastercard, etc.
app.payment.card_valid           - bool   - Card validation result
app.loyalty.level                - string - platinum, gold, silver, bronze
app.payment.charged              - bool   - Payment charged flag
```
**Metric**: `app.payment.transactions` (counter)

### Currency Service (C++)
```
app.currency.conversion.from     - string - Source currency code
app.currency.conversion.to       - string - Target currency code
```

### Shipping Service (Rust)
```
app.shipping.zip_code            - string - Zip code from address
app.shipping.tracking.id         - string - Generated tracking ID
app.shipping.items.count         - int    - Number of items
app.shipping.cost.total          - string - Total shipping cost
```

### Checkout Service (Go)
```
app.user.id                      - string - User ID
app.user.currency                - string - User's currency
app.user.city                    - string - User's city
app.order.id                     - string - Order ID
app.order.amount                 - double - Total order amount
app.order.items.count            - int    - Items in order
app.cart.items.count             - int    - Items in cart
app.shipping.amount              - double - Shipping cost
messaging.kafka.producer.success - bool   - Kafka send success
messaging.kafka.producer.duration_ms - int - Kafka operation duration
```

### Product Catalog Service (Go)
```
app.product.id                   - string - Product ID
app.product.name                 - string - Product name
app.products.count               - int    - Total products
app.products_search.count        - int    - Search results count
```

### Quote Service (PHP)
```
app.quote.items.count            - int    - Items in quote
app.quote.cost.total             - double - Total quote cost
```
**Metric**: `quotes` (counter)

### Recommendation Service (Python)
```
app.products_recommended.count   - int    - Number of recommendations
app.recommendation.cache_enabled - bool   - Cache enabled flag
app.cache_hit                    - bool   - Cache hit indicator
app.products.count               - int    - Total available products
app.filtered_products.count      - int    - Filtered product count
app.filtered_products.list       - string - Product ID list
```
**Metric**: `app_recommendations_counter` (counter)

### Email Service (Ruby)
```
app.email.recipient              - string - Email recipient
app.order.id                     - string - Order ID
```

### Frontend Service (TypeScript)
```
session.id                       - string - User session ID
app.synthetic_request            - bool   - Synthetic request flag
app.request.method               - string - HTTP method
app.request.target               - string - Request path
app.request.user_agent           - string - User agent
app.response.status_code         - int    - HTTP status code
app.response.duration_ms         - int    - Response duration
```
**Metric**: `app.frontend.requests` (counter)

### React Native App (TypeScript)
```
session.id                       - string - User session ID
```

## By Type

### Counters (Metrics)
- `app.ads.ad_requests` - Ad requests by type
- `app.payment.transactions` - Payment transactions
- `quotes` - Quotes calculated
- `app_recommendations_counter` - Recommendations given
- `app.frontend.requests` - Frontend API requests

### Boolean Attributes
- `app.payment.card_valid`
- `app.payment.charged`
- `app.recommendation.cache_enabled`
- `app.cache_hit`
- `messaging.kafka.producer.success`
- `app.synthetic_request`

### String Attributes
- `app.ads.contextKeys`
- `app.ads.ad_request_type`
- `app.ads.ad_response_type`
- `app.ads.category`
- `app.payment.card_type`
- `app.loyalty.level`
- `app.currency.conversion.from`
- `app.currency.conversion.to`
- `app.shipping.zip_code`
- `app.shipping.tracking.id`
- `app.shipping.cost.total`
- `app.user.id`
- `app.user.currency`
- `app.user.city`
- `app.order.id`
- `app.product.id`
- `app.product.name`
- `app.email.recipient`
- `session.id`
- `app.request.method`
- `app.request.target`
- `app.request.user_agent`
- `app.filtered_products.list`

### Integer Attributes
- `app.ads.count`
- `app.ads.contextKeys.count`
- `app.shipping.items.count`
- `app.order.items.count`
- `app.cart.items.count`
- `app.products.count`
- `app.products_search.count`
- `app.quote.items.count`
- `app.products_recommended.count`
- `app.filtered_products.count`
- `messaging.kafka.producer.duration_ms`
- `app.response.status_code`
- `app.response.duration_ms`

### Double/Float Attributes
- `app.order.amount`
- `app.shipping.amount`
- `app.quote.cost.total`

## Cross-Service Attributes

These attributes appear in multiple services:

1. **session.id** - Ad Service, Frontend, React Native App
2. **app.order.id** - Checkout Service, Email Service
3. **app.products.count** - Product Catalog, Recommendation Service
4. **app.shipping.amount** - Checkout Service (multiple contexts)

## Naming Convention

All custom attributes follow this pattern:
```
[namespace].[service].[concept].[modifier]
```

Examples:
- `app.ads.count` - app namespace, ads service, count concept
- `app.payment.card_type` - app namespace, payment service, card type
- `messaging.kafka.producer.success` - messaging namespace, kafka producer, success

## Adding New Attributes

When adding new custom attributes:

1. Follow the naming convention: `app.[service].[concept].[modifier]`
2. Use appropriate types: string, int, double, boolean
3. Document in `registry.yaml`
4. Add to this quick reference
5. Consider if it should be cross-service (like session.id)
6. Validate attribute cardinality to avoid high-cardinality issues

