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

    # Credentials come from the pod's identity (EKS Pod Identity
    # Association) — no API key handling needed here.
    return ChatBedrockConverse(**kwargs)
