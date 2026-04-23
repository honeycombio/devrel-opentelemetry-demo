#!/usr/bin/python
# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""
Pluggable LLM client for product-reviews. Two providers, selected by the
`LLM_PROVIDER` env var:

  * "openai"  (default)  talks to an OpenAI-compatible endpoint using the
                         `openai` SDK. Upstream's `src/llm/` fake service is
                         a valid target; so is any other OpenAI-compatible
                         server. Requires LLM_BASE_URL + LLM_MODEL.
  * "bedrock"            talks to AWS Bedrock's Converse API via `boto3`.
                         Requires AWS_REGION + BEDROCK_HAIKU_PROFILE_ARN.
                         Auth comes from whichever AWS credential provider
                         chain is in effect (EKS Pod Identity, env vars, etc.).

Feature flags (`llmRateLimitError`, `llmInaccurateResponse`) are enforced here
so the handler doesn't need to know which provider is active. Instrumentation
is auto-applied at runtime by `opentelemetry-instrument` via the
`opentelemetry-instrumentation-openai-v2` and
`opentelemetry-instrumentation-botocore` packages — both emit GenAI semantic
convention attributes (and promote to latest-experimental when
OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental).
"""

import json
import logging
import os
import random
from dataclasses import dataclass, field
from typing import Optional

import boto3
from openai import OpenAI
from openfeature import api as openfeature_api
from opentelemetry import trace
from opentelemetry.trace import SpanKind

LOG = logging.getLogger(__name__)
_tracer = trace.get_tracer(__name__)

# Bound on the tool-use loop; today's flow needs one round, this is headroom.
MAX_TOOL_ROUNDS = 4

# Keep upstream's demo behaviour: when `llmInaccurateResponse` is on, the wrong
# answer is only served for this specific product id.
INACCURATE_PRODUCT_ID = "L9ECAV7KIM"


class LLMRateLimitError(Exception):
    """Raised when `llmRateLimitError` short-circuits the call."""


@dataclass
class ToolCall:
    id: str
    name: str
    # JSON-encoded string; matches OpenAI's `function.arguments` shape.
    arguments: str


@dataclass
class ChatResult:
    text: Optional[str]
    tool_calls: list = field(default_factory=list)
    # "stop" or "tool_use"; abstracts over OpenAI's finish_reason and Bedrock's stopReason.
    finish_reason: str = "stop"
    input_tokens: int = 0
    output_tokens: int = 0


def _check_flag(flag_name: str) -> bool:
    try:
        return openfeature_api.get_client().get_boolean_value(flag_name, False)
    except Exception:
        return False


def _mentions_inaccurate_product(messages: list[dict]) -> bool:
    needle = f"product ID:{INACCURATE_PRODUCT_ID}"
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, str) and needle in content:
            return True
    return False


def _apply_inaccurate_flag(system_prompt: str, messages: list[dict]) -> str:
    if _check_flag("llmInaccurateResponse") and _mentions_inaccurate_product(messages):
        LOG.info("llmInaccurateResponse on — injecting inaccuracy instruction")
        return (
            system_prompt
            + " IMPORTANT: For this request, deliberately return a wrong but "
              "plausible-sounding summary rather than an accurate one."
        )
    return system_prompt


def chat_with_tools(
    system_prompt: str,
    messages: list[dict],
    tools: list[dict],
) -> ChatResult:
    """Run a single LLM turn with optional tool-use. Raises LLMRateLimitError
    when the `llmRateLimitError` flag triggers.

    messages uses a common shape:
      {"role": "user"|"assistant"|"tool",
       "content": str | None,
       "tool_calls": [{"id","name","arguments"}] | None,
       "tool_call_id": str | None}

    tools uses a common shape:
      {"name", "description", "parameters": <JSON schema>}
    """
    if _check_flag("llmRateLimitError") and random.random() < 0.5:
        LOG.info("llmRateLimitError on — short-circuiting to rate-limit error")
        raise LLMRateLimitError("rate limit (simulated via llmRateLimitError flag)")

    system_prompt = _apply_inaccurate_flag(system_prompt, messages)
    provider = os.environ.get("LLM_PROVIDER", "openai").lower()
    LOG.info(f"Dispatching chat_with_tools via provider={provider}")
    if provider == "openai":
        return _openai_chat(system_prompt, messages, tools)
    if provider == "bedrock":
        return _bedrock_chat(system_prompt, messages, tools)
    raise ValueError(f"Unknown LLM_PROVIDER: {provider!r}")


# --- OpenAI backend --------------------------------------------------------

def _openai_client() -> OpenAI:
    return OpenAI(
        base_url=os.environ["LLM_BASE_URL"],
        api_key=os.environ.get("OPENAI_API_KEY") or "unused",
    )


def _messages_to_openai(system_prompt: str, messages: list[dict]) -> list[dict]:
    out = [{"role": "system", "content": system_prompt}]
    for msg in messages:
        role = msg["role"]
        if role == "tool":
            out.append({
                "role": "tool",
                "tool_call_id": msg["tool_call_id"],
                "content": msg["content"],
            })
        elif role == "assistant" and msg.get("tool_calls"):
            out.append({
                "role": "assistant",
                "content": msg.get("content") or None,
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": tc["arguments"]},
                    }
                    for tc in msg["tool_calls"]
                ],
            })
        else:
            out.append({"role": role, "content": msg.get("content", "")})
    return out


def _tools_to_openai(tools: list[dict]) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["parameters"],
            },
        }
        for t in tools
    ]


def _openai_chat(system_prompt: str, messages: list[dict], tools: list[dict]) -> ChatResult:
    client = _openai_client()
    kwargs = {
        "model": os.environ["LLM_MODEL"],
        "messages": _messages_to_openai(system_prompt, messages),
    }
    if tools:
        kwargs["tools"] = _tools_to_openai(tools)
        kwargs["tool_choice"] = "auto"
    resp = client.chat.completions.create(**kwargs)
    choice = resp.choices[0]
    tool_calls = [
        ToolCall(id=tc.id, name=tc.function.name, arguments=tc.function.arguments)
        for tc in (choice.message.tool_calls or [])
    ]
    usage = resp.usage
    return ChatResult(
        text=choice.message.content,
        tool_calls=tool_calls,
        finish_reason="tool_use" if tool_calls else "stop",
        input_tokens=(getattr(usage, "prompt_tokens", 0) or 0) if usage else 0,
        output_tokens=(getattr(usage, "completion_tokens", 0) or 0) if usage else 0,
    )


# --- Bedrock backend -------------------------------------------------------

_bedrock_client_instance = None


def _bedrock_client():
    global _bedrock_client_instance
    if _bedrock_client_instance is None:
        _bedrock_client_instance = boto3.client(
            "bedrock-runtime",
            region_name=os.environ["AWS_REGION"],
        )
    return _bedrock_client_instance


def _messages_to_bedrock(messages: list[dict]) -> list[dict]:
    """Translate the common message shape into Bedrock Converse format.

    Bedrock expects alternating user/assistant messages; tool results are
    carried as `toolResult` content blocks inside a user-role message. We
    buffer consecutive `role: tool` entries and flush them as one user message.
    """
    out = []
    pending_tool_results: list[dict] = []
    for msg in messages:
        role = msg["role"]
        if role == "tool":
            pending_tool_results.append({
                "toolResult": {
                    "toolUseId": msg["tool_call_id"],
                    "content": [{"text": msg["content"]}],
                }
            })
            continue
        if pending_tool_results:
            out.append({"role": "user", "content": pending_tool_results})
            pending_tool_results = []
        if role == "assistant" and msg.get("tool_calls"):
            blocks = []
            if msg.get("content"):
                blocks.append({"text": msg["content"]})
            for tc in msg["tool_calls"]:
                blocks.append({
                    "toolUse": {
                        "toolUseId": tc["id"],
                        "name": tc["name"],
                        "input": json.loads(tc["arguments"]),
                    }
                })
            out.append({"role": "assistant", "content": blocks})
        else:
            out.append({
                "role": role,
                "content": [{"text": msg.get("content") or ""}],
            })
    if pending_tool_results:
        out.append({"role": "user", "content": pending_tool_results})
    return out


def _tools_to_bedrock(tools: list[dict]) -> dict:
    # Trailing `cachePoint` block marks the end of the (stable) tool definitions
    # as a Bedrock prompt-cache boundary. Bedrock caches everything before it —
    # system prompt + tools — and charges ~0.1x on subsequent turns/requests
    # that hit the cache. Caching silently no-ops if the cached prefix is below
    # the model's minimum token threshold, so this is always safe to include.
    return {
        "tools": [
            {
                "toolSpec": {
                    "name": t["name"],
                    "description": t["description"],
                    "inputSchema": {"json": t["parameters"]},
                }
            }
            for t in tools
        ] + [{"cachePoint": {"type": "default"}}]
    }


def _bedrock_chat(system_prompt: str, messages: list[dict], tools: list[dict]) -> ChatResult:
    bedrock_messages = _messages_to_bedrock(messages)
    kwargs = {
        "modelId": os.environ["BEDROCK_HAIKU_PROFILE_ARN"],
        # Cache the system prompt alongside the tools (see _tools_to_bedrock) —
        # together they form the stable prefix that's identical across every
        # turn of the tool-use loop and across requests.
        "system": [
            {"text": system_prompt},
            {"cachePoint": {"type": "default"}},
        ],
        "messages": bedrock_messages,
        "inferenceConfig": {"maxTokens": 1024},
    }
    if tools:
        kwargs["toolConfig"] = _tools_to_bedrock(tools)

    # Span name follows the OTel GenAI semconv pattern `{operation} {model}`,
    # kind=CLIENT. Emits the latest-semconv message attributes directly on
    # the span; opentelemetry-instrumentation-botocore's Bedrock extension is
    # disabled via OTEL_PYTHON_DISABLED_INSTRUMENTATIONS (it would otherwise
    # emit a duplicate auto `chat <model>` span plus per-message events via
    # the Events API that OTTL can't aggregate back onto the span).
    model_id = kwargs["modelId"]
    with _tracer.start_as_current_span(
        f"chat {model_id}", kind=SpanKind.CLIENT,
    ) as span:
        span.set_attribute("gen_ai.provider.name", "aws.bedrock")
        span.set_attribute("gen_ai.operation.name", "chat")
        span.set_attribute("gen_ai.request.model", model_id)
        span.set_attribute(
            "gen_ai.input.messages",
            json.dumps(
                [{"role": "system", "content": [{"text": system_prompt}]}]
                + bedrock_messages
            ),
        )
        if tools:
            span.set_attribute(
                "gen_ai.tool.definitions",
                json.dumps([
                    {"name": t["name"],
                     "description": t["description"],
                     "parameters": t["parameters"]}
                    for t in tools
                ]),
            )

        resp = _bedrock_client().converse(**kwargs)

        output_message = resp["output"]["message"]
        span.set_attribute(
            "gen_ai.output.messages",
            json.dumps([{"role": "assistant",
                         "content": output_message.get("content", [])}]),
        )
        stop_reason = resp.get("stopReason", "end_turn")
        usage = resp.get("usage") or {}
        span.set_attribute("gen_ai.response.finish_reasons", [stop_reason])
        span.set_attribute("gen_ai.usage.input_tokens", usage.get("inputTokens", 0))
        span.set_attribute("gen_ai.usage.output_tokens", usage.get("outputTokens", 0))
        # Bedrock returns these only when a cachePoint is configured and the
        # prefix hits the model's minimum. Missing -> 0 means we either didn't
        # try to cache or the cacheable prefix was too small this turn.
        span.set_attribute(
            "gen_ai.usage.cache_read.input_tokens",
            usage.get("cacheReadInputTokens", 0) or 0,
        )
        span.set_attribute(
            "gen_ai.usage.cache_write.input_tokens",
            usage.get("cacheWriteInputTokens", 0) or 0,
        )
    text_parts: list[str] = []
    tool_calls: list[ToolCall] = []
    for block in output_message.get("content", []):
        if "text" in block:
            text_parts.append(block["text"])
        if "toolUse" in block:
            tu = block["toolUse"]
            tool_calls.append(ToolCall(
                id=tu["toolUseId"],
                name=tu["name"],
                arguments=json.dumps(tu["input"]),
            ))
    return ChatResult(
        text="\n".join(text_parts) if text_parts else None,
        tool_calls=tool_calls,
        finish_reason="tool_use" if stop_reason == "tool_use" else "stop",
        input_tokens=usage.get("inputTokens", 0),
        output_tokens=usage.get("outputTokens", 0),
    )
