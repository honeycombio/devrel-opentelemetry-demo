#!/bin/bash
# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

set -e

# Script to build and serve OpenTelemetry conventions documentation

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Functions
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Check if registry.yaml exists
if [ ! -f "$PROJECT_ROOT/src/conventions/registry.yaml" ]; then
    print_error "registry.yaml not found at $PROJECT_ROOT/src/conventions/registry.yaml"
    exit 1
fi

print_info "Building OpenTelemetry conventions documentation..."
print_info "Project root: $PROJECT_ROOT"

# Build the Docker image
print_info "Building Docker image..."
docker build \
    -f "$PROJECT_ROOT/src/conventions/Dockerfile" \
    -t otel-conventions-docs:latest \
    "$PROJECT_ROOT/src/conventions"

if [ $? -eq 0 ]; then
    print_info "Docker image built successfully"
else
    print_error "Failed to build Docker image"
    exit 1
fi

# Check if user wants to run the container
if [ "$1" == "--run" ] || [ "$1" == "-r" ]; then
    print_info "Starting documentation server..."
    docker run \
        --rm \
        -p 8000:8000 \
        -v "$PROJECT_ROOT/src/conventions:/app/docs:rw" \
        --name otel-conventions-docs \
        otel-conventions-docs:latest
elif [ "$1" == "--compose" ] || [ "$1" == "-c" ]; then
    print_info "Starting documentation server with docker-compose..."
    cd "$PROJECT_ROOT"
    docker-compose -f docker-compose.docs.yml up
else
    print_info "Docker image built successfully!"
    print_info ""
    print_info "To run the documentation server, use one of the following:"
    print_info ""
    print_info "  Option 1 - Using this script:"
    print_info "    $0 --run"
    print_info ""
    print_info "  Option 2 - Using docker-compose:"
    print_info "    $0 --compose"
    print_info ""
    print_info "  Option 3 - Using docker directly:"
    print_info "    docker run -p 8000:8000 otel-conventions-docs:latest"
    print_info ""
    print_info "Once running, access the documentation at: http://localhost:8000"
fi

