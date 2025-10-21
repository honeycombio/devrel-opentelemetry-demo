# OpenTelemetry Conventions Registry

This directory contains the OpenTelemetry Weaver registry and documentation for all custom attributes and metrics used across the OpenTelemetry Demo application.

## Files

### 1. **registry.yaml** - Main Registry
The authoritative OpenTelemetry Weaver registry containing:
- All custom span attributes organized by service group
- All custom metrics with descriptions
- Attribute types, examples, and usage notes
- Duplicate attribute analysis

**Format**: OpenTelemetry Weaver YAML format
**Usage**: Can be used with OpenTelemetry Weaver tooling for code generation and validation

### 2. **QUICK_REFERENCE.md** - Quick Lookup Guide
Fast reference guide organized by:
- Service (for finding attributes by service)
- Attribute type (for finding all booleans, strings, etc.)
- Cross-service attributes
- Naming conventions
- Guidelines for adding new attributes

**Best for**: Developers looking up specific attributes or understanding naming patterns

### 3. **DUPLICATE_ANALYSIS.md** - Duplicate Attribute Analysis
Detailed analysis of all duplicate attribute names:
- Status classification (Intentional, Same-Service, Similar)
- Reasoning for each duplicate
- Recommendations
- Best practices applied
- Summary table

**Best for**: Understanding why certain attributes appear in multiple services

## Quick Stats

| Metric | Count |
|--------|-------|
| Services Analyzed | 15 |
| Services with Custom Instrumentation | 11 |
| Custom Span Attributes | 50+ |
| Custom Metrics | 6 |
| Duplicate Attribute Names | 5 |
| Intentional Duplicates | 5 |

## Attribute Naming Convention

All custom attributes follow this pattern:

```
[namespace].[service].[concept].[modifier]
```

### Examples
- `app.ads.count` - app namespace, ads service, count concept
- `app.payment.card_type` - app namespace, payment service, card type
- `messaging.kafka.producer.success` - messaging namespace, kafka producer, success

### Namespaces Used
- `app.*` - Application-specific attributes
- `messaging.*` - Messaging system attributes
- `session.*` - Session/user tracking attributes

## Services Covered

### With Custom Instrumentation
1. **Ad Service** (Java) - 7 attributes, 1 metric
2. **Payment Service** (Node.js) - 4 attributes, 1 metric
3. **Currency Service** (C++) - 2 attributes
4. **Shipping Service** (Rust) - 4 attributes
5. **Checkout Service** (Go) - 10 attributes
6. **Product Catalog Service** (Go) - 4 attributes
7. **Quote Service** (PHP) - 2 attributes, 1 metric
8. **Recommendation Service** (Python) - 6 attributes, 1 metric
9. **Email Service** (Ruby) - 2 attributes
10. **Frontend Service** (TypeScript) - 7 attributes, 1 metric
11. **React Native App** (TypeScript) - 1 attribute

### With Auto-Instrumentation Only
- Accounting Service (C#)
- Fraud Detection Service (Kotlin)
- Cart Service (C#)
- Image Provider Service

## Key Findings

### Intentional Cross-Service Attributes
- **session.id** - Used in Ad Service, Frontend, and React Native App for user session tracking
- **app.order.id** - Flows from Checkout Service to Email Service for order tracking

### Metrics
- `app.ads.ad_requests` - Ad requests by type
- `app.payment.transactions` - Payment transactions
- `quotes` - Quotes calculated
- `app_recommendations_counter` - Recommendations given
- `app.frontend.requests` - Frontend API requests

## Using This Registry

### For Development
1. Check `QUICK_REFERENCE.md` for existing attributes
2. Follow the naming convention when adding new attributes
3. Update `registry.yaml` with new attributes
4. Document in the appropriate service section

### For Code Generation
Use `registry.yaml` with OpenTelemetry Weaver tools:
```bash
weaver generate code --registry registry.yaml
```

### For Validation
Validate that your instrumentation code uses attributes defined in this registry.

## Adding New Attributes

When adding new custom attributes:

1. **Choose a name** following the convention: `app.[service].[concept].[modifier]`
2. **Determine the type**: string, int, double, boolean
3. **Add to registry.yaml** in the appropriate service group
4. **Update QUICK_REFERENCE.md** with the new attribute
5. **Document in code** with comments explaining the attribute
6. **Consider cardinality** - avoid high-cardinality attributes

## Best Practices

✅ **Do**:
- Use consistent naming conventions
- Document all custom attributes
- Consider attribute cardinality
- Use cross-service attributes for correlation (like session.id)
- Group related attributes by service

❌ **Don't**:
- Create high-cardinality attributes (e.g., user email as attribute)
- Use inconsistent naming patterns
- Add attributes without documentation
- Duplicate attribute names without clear reason

## Related Documentation

- **OTEL_ATTRIBUTES_ANALYSIS.md** - Comprehensive analysis in notes/ directory
- **OpenTelemetry Semantic Conventions** - https://opentelemetry.io/docs/specs/semconv/
- **OpenTelemetry Weaver** - https://github.com/open-telemetry/weaver

## Maintenance

This registry should be updated whenever:
- New custom attributes are added to services
- Existing attributes are modified or removed
- New services with custom instrumentation are added
- Naming conventions are updated

Last Updated: 2025-10-17

