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

ENV OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
