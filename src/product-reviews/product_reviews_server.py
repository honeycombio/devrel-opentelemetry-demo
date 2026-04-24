#!/usr/bin/python

# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0


# Python
import os
import json
from concurrent import futures

# Pip
import grpc
from opentelemetry import trace, metrics
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import (
    OTLPLogExporter,
)
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.trace import Status, StatusCode

# Local
import logging
import demo_pb2
import demo_pb2_grpc
from grpc_health.v1 import health_pb2
from grpc_health.v1 import health_pb2_grpc
from database import fetch_product_reviews, fetch_product_reviews_from_db, fetch_avg_product_review_score_from_db
import llm_client
from llm_evals_publisher import publish_eval

from openfeature import api
from openfeature.contrib.provider.flagd import FlagdProvider

from metrics import (
    init_metrics
)

from google.protobuf.json_format import MessageToJson, MessageToDict

# Provider-agnostic tool specs — translated into the native shape for each
# backend inside `llm_client`. Same schemas as upstream's OpenAI tools.
TOOLS = [
    {
        "name": "fetch_product_reviews",
        "description": "Executes a SQL query to retrieve reviews for a particular product.",
        "parameters": {
            "type": "object",
            "properties": {
                "product_id": {
                    "type": "string",
                    "description": "The product ID to fetch product reviews for.",
                }
            },
            "required": ["product_id"],
        },
    },
    {
        "name": "fetch_product_info",
        "description": "Retrieves information for a particular product.",
        "parameters": {
            "type": "object",
            "properties": {
                "product_id": {
                    "type": "string",
                    "description": "The product ID to fetch information for.",
                }
            },
            "required": ["product_id"],
        },
    },
]

class ProductReviewService(demo_pb2_grpc.ProductReviewServiceServicer):
    def GetProductReviews(self, request, context):
        logger.info(f"Receive GetProductReviews for product id:{request.product_id}")
        product_reviews = get_product_reviews(request.product_id)

        return product_reviews

    def GetAverageProductReviewScore(self, request, context):
        logger.info(f"Receive GetAverageProductReviewScore for product id:{request.product_id}")
        product_reviews = get_average_product_review_score(request.product_id)

        return product_reviews

    def AskProductAIAssistant(self, request, context):
        logger.info(f"Receive AskProductAIAssistant for product id:{request.product_id}, question: {request.question}")
        ai_assistant_response = get_ai_assistant_response(request.product_id, request.question)

        return ai_assistant_response

    def Check(self, request, context):
        return health_pb2.HealthCheckResponse(
            status=health_pb2.HealthCheckResponse.SERVING)

    def Watch(self, request, context):
        return health_pb2.HealthCheckResponse(
            status=health_pb2.HealthCheckResponse.UNIMPLEMENTED)

def get_product_reviews(request_product_id):

    with tracer.start_as_current_span("get_product_reviews") as span:

        span.set_attribute("app.product.id", request_product_id)

        product_reviews = demo_pb2.GetProductReviewsResponse()
        records = fetch_product_reviews_from_db(request_product_id)

        for row in records:
            logger.info(f"  username: {row[0]}, description: {row[1]}, score: {str(row[2])}")
            product_reviews.product_reviews.add(
                    username=row[0],
                    description=row[1],
                    score=str(row[2])
            )

        span.set_attribute("app.product_reviews.count", len(product_reviews.product_reviews))

        # Collect metrics for this service
        product_review_svc_metrics["app_product_review_counter"].add(len(product_reviews.product_reviews), {'product.id': request_product_id})

        return product_reviews

def get_average_product_review_score(request_product_id):

    with tracer.start_as_current_span("get_average_product_review_score") as span:

        span.set_attribute("app.product.id", request_product_id)

        product_review_score = demo_pb2.GetAverageProductReviewScoreResponse()
        avg_score = fetch_avg_product_review_score_from_db(request_product_id)
        product_review_score.average_score = avg_score

        span.set_attribute("app.product_reviews.average_score", avg_score)

        return product_review_score

SYSTEM_PROMPT = (
    "You are a helpful assistant that answers questions about a specific "
    "product. Use the provided tools to fetch the product's reviews and "
    "product information, then ground your answer in those results. Do not "
    "invent facts. Keep the response brief — no more than 1-2 sentences. If "
    "you don't know the answer, just say you don't know."
)


def _execute_tool(name, arguments):
    if name == "fetch_product_reviews":
        return fetch_product_reviews(product_id=arguments.get("product_id"))
    if name == "fetch_product_info":
        return fetch_product_info(product_id=arguments.get("product_id"))
    raise Exception(f"Received unexpected tool call request: {name}")


def get_ai_assistant_response(request_product_id, question):
    """Run a tool-use loop against whichever LLM provider `llm_client` is
    configured for. The loop fetches whatever context the model asks for
    (via the `fetch_product_reviews` / `fetch_product_info` tools) and returns
    the model's final grounded answer.
    """

    with tracer.start_as_current_span("get_ai_assistant_response") as span:

        ai_assistant_response = demo_pb2.AskProductAIAssistantResponse()

        span.set_attribute("app.product.id", request_product_id)
        span.set_attribute("app.product.question", question)

        user_message = f"Answer the following question about product ID:{request_product_id}: {question}"
        messages = [{"role": "user", "content": user_message}]

        try:
            for _ in range(llm_client.MAX_TOOL_ROUNDS):
                result = llm_client.chat_with_tools(SYSTEM_PROMPT, messages, TOOLS)

                if result.finish_reason == "stop":
                    ai_assistant_response.response = result.text or ""
                    logger.info(f"Returning an AI assistant response: '{result.text}'")
                    product_review_svc_metrics["app_ai_assistant_counter"].add(
                        1, {"product.id": request_product_id}
                    )
                    grounding = "\n\n".join(
                        m["content"] for m in messages
                        if m["role"] == "tool" and isinstance(m.get("content"), str)
                    )
                    provider = os.environ.get("LLM_PROVIDER", "openai").lower()
                    response_model = (
                        os.environ.get("BEDROCK_HAIKU_PROFILE_ARN")
                        if provider == "bedrock"
                        else os.environ.get("LLM_MODEL")
                    )
                    publish_eval(
                        input_text=user_message,
                        output_text=result.text or "",
                        agent_name="product_reviews_ai_assistant",
                        grounding_context=grounding,
                        response_model=response_model,
                        input_tokens=result.input_tokens,
                        output_tokens=result.output_tokens,
                    )
                    return ai_assistant_response

                # Model requested tools — record the assistant turn and execute each call.
                messages.append({
                    "role": "assistant",
                    "content": result.text,
                    "tool_calls": [
                        {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                        for tc in result.tool_calls
                    ],
                })

                for call in result.tool_calls:
                    with tracer.start_as_current_span(f"execute_tool {call.name}") as tool_span:
                        tool_span.set_attribute("gen_ai.operation.name", "execute_tool")
                        tool_span.set_attribute("gen_ai.tool.name", call.name)
                        tool_span.set_attribute("gen_ai.tool.call.id", call.id)
                        tool_span.set_attribute("gen_ai.tool.call.arguments", call.arguments)
                        try:
                            args = json.loads(call.arguments)
                            tool_output = _execute_tool(call.name, args)
                        except Exception as e:
                            logger.error(f"Tool '{call.name}' failed: {e}")
                            tool_span.record_exception(e)
                            tool_span.set_status(Status(StatusCode.ERROR, description=str(e)))
                            tool_output = json.dumps({"error": str(e)})
                        messages.append({
                            "role": "tool",
                            "tool_call_id": call.id,
                            "content": tool_output,
                        })

            raise RuntimeError("LLM exceeded max tool-use rounds without finishing")

        except llm_client.LLMRateLimitError as e:
            logger.info(f"Short-circuited by llmRateLimitError: {e}")
            span.record_exception(e)
            span.set_status(Status(StatusCode.ERROR, description=str(e)))
            ai_assistant_response.response = "The system is temporarily rate-limited. Please try again later."
            return ai_assistant_response
        except Exception as e:
            logger.error(f"Caught Exception: {e}")
            span.record_exception(e)
            span.set_status(Status(StatusCode.ERROR, description=str(e)))
            ai_assistant_response.response = "The system is unable to process your response. Please try again later."
            return ai_assistant_response

def fetch_product_info(product_id):
    try:
        product = product_catalog_stub.GetProduct(demo_pb2.GetProductRequest(id=product_id))
        logger.info(f"product_catalog_stub.GetProduct returned: '{product}'")
        json_str = MessageToJson(product)
        return json_str
    except Exception as e:
        return json.dumps({"error": str(e)})

def must_map_env(key: str):
    value = os.environ.get(key)
    if value is None:
        raise Exception(f'{key} environment variable must be set')
    return value

if __name__ == "__main__":
    service_name = must_map_env('OTEL_SERVICE_NAME')

    api.set_provider(FlagdProvider(host=os.environ.get('FLAGD_HOST', 'flagd'), port=os.environ.get('FLAGD_PORT', 8013)))

    # Initialize Traces and Metrics
    tracer = trace.get_tracer_provider().get_tracer(service_name)
    meter = metrics.get_meter_provider().get_meter(service_name)

    product_review_svc_metrics = init_metrics(meter)

    # Initialize Logs
    logger_provider = LoggerProvider(
        resource=Resource.create(
            {
                'service.name': service_name,
            }
        ),
    )
    set_logger_provider(logger_provider)
    log_exporter = OTLPLogExporter(insecure=True)
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))
    handler = LoggingHandler(level=logging.NOTSET, logger_provider=logger_provider)

    # Attach OTLP handler to logger
    logger = logging.getLogger('main')
    logger.addHandler(handler)

    # Create gRPC server
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))

    # Add class to gRPC server
    service = ProductReviewService()
    demo_pb2_grpc.add_ProductReviewServiceServicer_to_server(service, server)
    health_pb2_grpc.add_HealthServicer_to_server(service, server)

    # LLM provider credentials (LLM_BASE_URL / LLM_MODEL / OPENAI_API_KEY for
    # the openai path; AWS_REGION / BEDROCK_HAIKU_PROFILE_ARN for bedrock)
    # are read directly by `llm_client` on demand.

    catalog_addr = must_map_env('PRODUCT_CATALOG_ADDR')
    pc_channel = grpc.insecure_channel(catalog_addr)
    product_catalog_stub = demo_pb2_grpc.ProductCatalogServiceStub(pc_channel)

    # Start server
    port = must_map_env('PRODUCT_REVIEWS_PORT')
    server.add_insecure_port(f'[::]:{port}')
    server.start()
    logger.info(f'Product reviews service started, listening on port {port}')
    server.wait_for_termination()
