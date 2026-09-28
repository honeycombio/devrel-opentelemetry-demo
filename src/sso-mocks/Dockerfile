# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

FROM golang:1.24-bookworm AS builder

WORKDIR /usr/src/app/

COPY ./src/sso-mocks/go.mod go.mod
COPY ./src/sso-mocks/main.go main.go

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags "-s -w" -o sso-mocks .

FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /usr/src/app/

COPY --from=builder /usr/src/app/sso-mocks ./
# demo-only key; owned by distroless's nonroot user so it can read it
COPY --chown=65532:65532 ./src/sso-mocks/certs/server.pem ./src/sso-mocks/certs/server-key.pem /certs/

EXPOSE 443
ENTRYPOINT [ "./sso-mocks" ]
