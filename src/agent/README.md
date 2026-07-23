# Agent Service

The Agent service provides an AI assistant for the OpenTelemetry Astronomy Shop
  demo. It exposes a FastAPI HTTP endpoint that accepts user prompts, routes them
  through a LangGraph ReAct agent, and uses either built-in shop tools or
  MCP-provided tools to interact with the demo application.

## Overview

- Runtime: Python 3.14
- Web framework: FastAPI served by Uvicorn
- Agent framework: LangChain and LangGraph prebuilt components
- LLM client: `langchain_aws.ChatBedrockConverse` — Amazon Bedrock, using the
  pod's identity for credentials (no API key)
- Observability: Traceloop SDK and OpenTelemetry OTLP export
- Optional tool source: Model Context Protocol (MCP)
- Default port: `8010`

The service starts from `run.py`, initializes Traceloop instrumentation, creates
 an `Agent`, and launches a FastAPI server.

## Service API

### `POST /prompt`

Submits a prompt to the agent.

Request body:

```json
{
  "message": "List available products",
  "history": []
}
```

Response body:

```json
{
  "response": {
    "messages": []
  }
}
```

The exact response shape is produced by the Langgraph agent invocation.

### Example Requests

Requires live Bedrock access (no VCR/cassette replay). Try:

1. Show all available products in the store.
2. What currencies are supported by the Astronomy Shop?
3. What current promotions are available on binoculars?

## Configuration

The service is configured with environment variables. Values can be supplied
through Docker Compose, `.env`, `.env.override`, or the local shell environment.

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_PORT` | `8010` | Port used by the FastAPI/Uvicorn server. |
| `AGENT_ENDPOINT` | `agent` in Compose | Service hostname used by other demo services. |
| `GRAPH_RECURSION_LIMIT` | `25` | Recursion limit read by the agent implementation. |
| `APPLICATION_ENDPOINT` | `localhost:8080` | Frontend/API endpoint used by built-in shop tools. In Compose this is usually `frontend:8080`. |
| `BEDROCK_MODEL_ID` | unset | Bedrock model id or inference-profile ARN. Falls back to `BEDROCK_HAIKU_PROFILE_ARN` if unset. |
| `BEDROCK_HAIKU_PROFILE_ARN` | unset | Shared Bedrock Haiku inference-profile ARN, same one `storechat` uses. |
| `BEDROCK_AWS_REGION` | `AWS_REGION`, else `us-east-1` | Region for the Bedrock client. |
| `MCP_ENABLED` | `False` | Enables tool loading from the MCP service when set to `True`. |
| `MCP_ENDPOINT` | `0.0.0.0` in code, `mcp` in Compose | Hostname for the MCP service. |
| `MCP_PORT` | `8011` | Port for the MCP service. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `localhost:4317` | OTLP endpoint used by Traceloop/OpenTelemetry. In Compose this points to the OpenTelemetry Collector. |
| `OTEL_EXPORTER_OTLP_INSECURE` | unset | Set to `true` in Compose for insecure local OTLP export. |
| `OTEL_RESOURCE_ATTRIBUTES` | inherited | Additional OpenTelemetry resource attributes. |
| `OTEL_SERVICE_NAME` | `AstronomyShopAgent` | Service name used in telemetry. |

> Do not commit real API keys. Prefer local overrides or secret management for `API_KEY`.
> Note that VCR file is created using `LLM_MODEL` and is case sensitive.

## Docker Compose Configuration

In `docker-compose.yml`, the service is named `agent` and is built from `src/agent/Dockerfile`.

Important Compose settings:

- Image: `${IMAGE_NAME}:${DEMO_VERSION}-agent`
- Container name: `agent`
- Dockerfile: `${AGENT_DOCKERFILE}`
- Memory limit: `500M`
- Restart policy: `unless-stopped`
- Exposed port: `${AGENT_PORT}`
- Depends on:
  - `jaeger`
  - `otel-collector`
  - `product-catalog`

The Compose configuration also enables MCP by default for this service with:

```text
MCP_ENABLED=True
MCP_ENDPOINT=mcp
MCP_PORT=8011
```

## Built-in Tools

When `MCP_ENABLED` is `False`, the agent uses built-in tools from `src/shared/tools.py`:

- `get_ads(category)` - fetches promotional ads.
- `list_products()` - lists available products.
- `get_product(product_id)` - gets product details.
- `add_to_cart(user_id, product_id, quantity)` - adds an item to a user's cart.
- `get_cart(user_id)` - retrieves a user's cart.
- `empty_cart(user_id)` - empties a user's cart.
- `checkout(checkout_person)` - performs checkout for a user's cart.
- `get_supported_currencies()` - lists supported currencies.
- `get_recommendations(product_id)` - gets product recommendations.
- `get_shipping_quote(items, currency_code, address)` - gets a shipping quote.

These tools call the frontend API through `APPLICATION_ENDPOINT`.

## MCP Tool Mode

When `MCP_ENABLED=True`, the service connects to:

```text
http://${MCP_ENDPOINT}:${MCP_PORT}/mcp
```

Tools are loaded dynamically using `langchain_mcp_adapters.tools.load_mcp_tools`.
 In this mode, the built-in tools are not used.

## Observability

`run.py` initializes Traceloop with:

- Application name: `agent`
- API endpoint: `OTEL_EXPORTER_OTLP_ENDPOINT`, defaulting to `localhost:4317`

The `run_agent` method is decorated as a Traceloop workflow named:

```text
astronomy_shop_agent_workflow
```

In Docker Compose, telemetry is sent to the local OpenTelemetry Collector and
 the service name is set to `agent`.

## Local Development

From the repository root, create or activate a Python environment, then
install dependencies:

```sh
pip install -r src/agent/requirements.txt
```

Run the service locally:

```sh
cd src/agent
AGENT_PORT=8010 \
APPLICATION_ENDPOINT=localhost:8080 \
BEDROCK_HAIKU_PROFILE_ARN=<bedrock-inference-profile-arn> \
BEDROCK_AWS_REGION=<aws-region> \
python run.py
```

If you want to use agent in MCP mode with `MCP_ENABLED=True`, follow [mcp readme](../mcp/README.md)

## Docker Build and Run

From the repository root, build the service image:

```sh
make build
```

or build only `agent` using

```sh
docker compose build agent
docker compose up agent
```

## Testing the Endpoint

After the service is running, send a prompt:

```sh
curl -X POST http://localhost:8010/prompt \
  -H 'Content-Type: application/json' \
  -d '{"message":"List products in the shop","history":[]}'
```

If running through Docker Compose and the `8080` port is not published to the
host, call it from another container or adjust Compose port publishing for local
 testing.

## File Layout

```text
src/agent/
|-- Dockerfile
|-- README.md
|-- requirements.txt
|-- requirements.in
|-- run.py
`-- src/
    `-- agents/
        |-- agents.py       # FastAPI app and LangChain agent orchestration
        |-- llm.py          # Bedrock (ChatBedrockConverse) LLM wrapper
        `-- mcp_client.py   # MCP streamable HTTP client
```

## Troubleshooting

- **`/prompt` returns HTTP 500**: Check Bedrock configuration
(`BEDROCK_MODEL_ID`/`BEDROCK_HAIKU_PROFILE_ARN`, `BEDROCK_AWS_REGION`) and MCP availability if MCP is enabled.
- **MCP connection fails**: Verify `MCP_ENDPOINT`, `MCP_PORT`,
and that the `mcp` service is running.
- **Built-in tools cannot reach the shop API**: Verify `APPLICATION_ENDPOINT`.
 Use `frontend:8080` in Docker Compose and `localhost:8080` for local
  host-based development.
- **No telemetry appears**: Verify `OTEL_EXPORTER_OTLP_ENDPOINT`,
collector availability, and `OTEL_SERVICE_NAME`.
- **TLS errors from the LLM provider**: Check certificates and `LLM_TLS_VERIFY`.
 Avoid disabling TLS verification outside local trusted environments.
