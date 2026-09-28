# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0


FROM golang:1.24-bookworm AS builder

WORKDIR /usr/src/app/

COPY ./src/auth/go.mod go.mod
COPY ./src/auth/go.sum go.sum

RUN go mod download

COPY ./src/auth/genproto/oteldemo/ genproto/oteldemo/
COPY ./src/auth/*.go ./

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags "-s -w" -o auth .

FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /usr/src/app/

COPY --from=builder /usr/src/app/auth ./

EXPOSE ${AUTH_PORT}
ENTRYPOINT [ "./auth" ]
