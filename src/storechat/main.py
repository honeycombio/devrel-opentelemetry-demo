import logging
import os

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from pydantic import BaseModel

import conversation
from agents import create_supervisor
from eval_anchor import SupervisorAgentAnchorProcessor, take_anchor
from llm_evals_publisher import publish_eval

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# OTel SDK setup
resource = Resource.create({
    "service.name": os.environ.get("OTEL_SERVICE_NAME", "store-chat"),
})
provider = TracerProvider(resource=resource)
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
provider.add_span_processor(SupervisorAgentAnchorProcessor())
trace.set_tracer_provider(provider)

app = FastAPI(title="Store Chat")

# OTel auto-instrumentation
FastAPIInstrumentor.instrument_app(app)
HTTPXClientInstrumentor().instrument()
RedisInstrumentor().instrument()

# Serve static files for the chat UI
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class ChatRequest(BaseModel):
    question: str
    sessionId: str
    email: str | None = None


class ChatResponse(BaseModel):
    response: str


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    # Set conversation ID on the current span
    current_span = trace.get_current_span()
    current_span.set_attribute("gen_ai.conversation.id", req.sessionId)
    if req.email:
        current_span.set_attribute("app.chat.request.email", req.email)

    # Load conversation history from Valkey
    history = conversation.get_history(req.sessionId)

    # Convert stored history to Strands message format
    messages = []
    for msg in history:
        messages.append({
            "role": msg["role"],
            "content": [{"text": msg["content"]}],
        })

    # Build the user prompt, including email context if provided
    user_prompt = req.question
    if req.email:
        user_prompt = f"[Customer email: {req.email}]\n{req.question}"

    # Create supervisor with conversation history and run
    supervisor = create_supervisor(
        conversation_id=req.sessionId,
        messages=messages if messages else None,
    )
    result = supervisor(user_prompt)
    response_text = str(result)

    # Save to conversation history
    conversation.append(req.sessionId, "user", req.question)
    conversation.append(req.sessionId, "assistant", response_text)

    request_ctx = trace.get_current_span().get_span_context()
    anchor = take_anchor(request_ctx.trace_id) if request_ctx.is_valid else None
    if anchor:
        anchor_trace_id, anchor_span_id, anchor_requested_at_ns = anchor
    else:
        anchor_trace_id = anchor_span_id = anchor_requested_at_ns = None
    publish_eval(
        input_text=user_prompt,
        output_text=response_text,
        agent_name="supervisor",
        response_model=os.environ.get("BEDROCK_MODEL_ID")
        or os.environ.get("BEDROCK_HAIKU_PROFILE_ARN"),
        conversation_id=req.sessionId,
        anchor_trace_id=anchor_trace_id,
        anchor_span_id=anchor_span_id,
        requested_at_ns=anchor_requested_at_ns,
    )

    return ChatResponse(response=response_text)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("STORE_CHAT_PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
