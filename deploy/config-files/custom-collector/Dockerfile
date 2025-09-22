FROM alpine:3.19 AS certs
RUN apk --update add ca-certificates

FROM golang:1.24 AS build-stage

WORKDIR /build

COPY ./ocb-config.yaml ocb-config.yaml

RUN go install go.opentelemetry.io/collector/cmd/builder@v0.129.0
RUN builder --config ocb-config.yaml

FROM gcr.io/distroless/base:latest

ARG USER_UID=10001
USER ${USER_UID}

COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chmod=755 --from=build-stage /build/otelcol-dev /otelcol

ENTRYPOINT ["/otelcol/otelcol-dev"]
CMD ["--config", "/etc/otelcol-contrib/config.yaml"]

EXPOSE 4317 4318 13133