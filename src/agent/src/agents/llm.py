#!/usr/bin/python

# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

import os

from langchain_aws import ChatBedrockConverse


def ChatLLM(**kwargs):
    # Model id/inference-profile ARN, same pattern storechat uses.
    model_id = os.getenv("BEDROCK_MODEL_ID", os.getenv("BEDROCK_HAIKU_PROFILE_ARN", ""))
    region_name = os.getenv("BEDROCK_AWS_REGION", os.getenv("AWS_REGION", "us-east-1"))

    kwargs.setdefault("model", model_id)
    kwargs.setdefault("region_name", region_name)
    kwargs.setdefault("max_tokens", 1024)
    # ChatBedrockConverse requires an explicit provider when model_id is an
    # inference-profile ARN rather than a bare model id (unlike Strands'
    # BedrockModel, which storechat uses and infers this itself).
    if ":inference-profile/" in model_id or model_id.startswith("arn:"):
        kwargs.setdefault("provider", os.getenv("BEDROCK_MODEL_PROVIDER", "anthropic"))

    # Credentials come from the pod's identity (EKS Pod Identity
    # Association) — no API key handling needed here.
    return ChatBedrockConverse(**kwargs)
