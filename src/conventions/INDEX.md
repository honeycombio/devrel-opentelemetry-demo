# OpenTelemetry Conventions Registry - Index

## 📋 Document Guide

This directory contains the complete OpenTelemetry conventions registry for the OpenTelemetry Demo application. Use this index to find what you need.

### 🎯 Start Here

**New to this registry?** Start with:
1. **README.md** - Overview and quick stats
2. **QUICK_REFERENCE.md** - Find attributes by service or type

### 📚 Complete Documentation

| Document | Purpose | Best For |
|----------|---------|----------|
| **registry.yaml** | Authoritative registry in Weaver format | Code generation, validation, tooling |
| **README.md** | Overview and usage guide | Understanding the registry structure |
| **QUICK_REFERENCE.md** | Fast lookup by service/type | Finding specific attributes |
| **DUPLICATE_ANALYSIS.md** | Analysis of duplicate names | Understanding cross-service attributes |

### 📖 Related Documentation

In the `notes/` directory:
- **OTEL_ATTRIBUTES_ANALYSIS.md** - Comprehensive analysis with service breakdown
- **ACTIVE.md** - Task completion summary

## 🔍 Finding What You Need

### I want to find an attribute...

**By Service Name:**
→ See QUICK_REFERENCE.md "By Service" section

**By Attribute Type:**
→ See QUICK_REFERENCE.md "By Type" section

**Complete Details:**
→ See registry.yaml for full definitions

### I want to understand...

**Why an attribute appears twice:**
→ See DUPLICATE_ANALYSIS.md

**How attributes are named:**
→ See README.md "Attribute Naming Convention"

**All attributes in a service:**
→ See QUICK_REFERENCE.md "By Service"

### I want to add a new attribute...

1. Read README.md "Adding New Attributes"
2. Follow the naming convention
3. Add to registry.yaml in the appropriate service group
4. Update QUICK_REFERENCE.md
5. Document in your code

## 📊 Quick Stats

```
Total Services:              15
Services with Custom Attrs:  11
Custom Span Attributes:      50+
Custom Metrics:              6
Duplicate Names:             5 (all intentional)
```

## 🏗️ Registry Structure

```
groups:
  - id: app.ads
    display_name: Ad Service Attributes
    attributes:
      - id: app.ads.count
        type: int
        description: ...
        examples: [...]
        notes: ...
```

## 🔗 Cross-Service Attributes

These attributes appear in multiple services:

| Attribute | Services | Purpose |
|-----------|----------|---------|
| session.id | Ad, Frontend, React Native | User session tracking |
| app.order.id | Checkout, Email | Order tracking |
| app.products.count | Product Catalog, Recommendation | Product counts |

## 📝 Naming Convention

```
[namespace].[service].[concept].[modifier]
```

**Namespaces:**
- `app.*` - Application-specific
- `messaging.*` - Messaging systems
- `session.*` - Session/user tracking

**Examples:**
- `app.ads.count` - Ad service, ads count
- `messaging.kafka.producer.success` - Kafka producer success
- `session.id` - Session identifier

## 🎓 Best Practices

✅ **Do:**
- Use consistent naming
- Document all attributes
- Consider cardinality
- Use cross-service attributes for correlation
- Group by service

❌ **Don't:**
- Create high-cardinality attributes
- Use inconsistent naming
- Add without documentation
- Duplicate without reason

## 🔄 Maintenance

Update this registry when:
- Adding new custom attributes
- Modifying existing attributes
- Removing attributes
- Adding new services with instrumentation
- Updating naming conventions

## 📞 Questions?

Refer to:
- **README.md** - General questions
- **QUICK_REFERENCE.md** - Finding attributes
- **DUPLICATE_ANALYSIS.md** - Understanding duplicates
- **registry.yaml** - Complete definitions

## 🚀 Using with Tools

### OpenTelemetry Weaver

Generate code from registry:
```bash
weaver generate code --registry registry.yaml
```

### Validation

Validate instrumentation against registry:
```bash
weaver validate --registry registry.yaml
```

## 📋 Checklist for Adding Attributes

- [ ] Attribute name follows convention
- [ ] Type is specified (string, int, double, boolean)
- [ ] Description is clear and concise
- [ ] Examples are provided
- [ ] Notes explain where it's used
- [ ] Added to registry.yaml
- [ ] Updated QUICK_REFERENCE.md
- [ ] Documented in code
- [ ] Cardinality is acceptable

## 🔗 External References

- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- [OpenTelemetry Weaver](https://github.com/open-telemetry/weaver)
- [OpenTelemetry Specification](https://opentelemetry.io/docs/specs/otel/)

---

**Last Updated:** 2025-10-17
**Registry Version:** 1.0
**Status:** Complete and Ready for Use

