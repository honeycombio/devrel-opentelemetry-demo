FROM python:3.12-slim

WORKDIR /app

COPY src/storechat/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Generate Python gRPC stubs from proto
COPY pb/demo.proto /proto/demo.proto
RUN mkdir -p /app/genproto \
    && python -m grpc_tools.protoc \
    -I/proto \
    --python_out=/app/genproto \
    --grpc_python_out=/app/genproto \
    /proto/demo.proto \
    && touch /app/genproto/__init__.py \
    && sed -i 's/^import demo_pb2/from genproto import demo_pb2/' /app/genproto/demo_pb2_grpc.py

COPY src/storechat/ .

EXPOSE 8080

# gen_ai_latest_experimental: emit the latest GenAI semconv shape.
# gen_ai_tool_definitions: include gen_ai.tool.definitions on invoke_agent
#   spans (Opt-In attribute in the spec's internal invoke_agent table).
# gen_ai_use_latest_invocation_tokens: scope invoke_agent usage tokens to the
#   current invocation rather than the agent object's accumulated totals.
ENV OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental,gen_ai_tool_definitions,gen_ai_use_latest_invocation_tokens

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
