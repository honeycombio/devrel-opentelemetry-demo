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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# OTel SDK setup
resource = Resource.create({
    "service.name": os.environ.get("OTEL_SERVICE_NAME", "store-chat"),
})
provider = TracerProvider(resource=resource)
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
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

    # Load conversation history from Valkey
    history = conversation.get_history(req.sessionId)

    # Convert stored history to Strands message format. Place a one-shot
    # Bedrock cachePoint on the first assistant message — this fixes the
    # cache breakpoint after turn 1 so the system+tools+turn1 prefix is
    # served from cache on every subsequent turn, while the growing tail
    # stays uncached. Doing it once (not on every assistant message) keeps
    # cache_write to a single event instead of paying the 1.25x write
    # premium on every turn as cache_config would.
    messages = []
    first_assistant_seen = False
    for msg in history:
        content: list[dict] = [{"text": msg["content"]}]
        if msg["role"] == "assistant" and not first_assistant_seen:
            content.append({"cachePoint": {"type": "default"}})
            first_assistant_seen = True
        messages.append({"role": msg["role"], "content": content})

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

    return ChatResponse(response=response_text)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("STORE_CHAT_PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
