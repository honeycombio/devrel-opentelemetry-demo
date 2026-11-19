FROM alpine:3.19 AS certs
RUN apk --update add ca-certificates

FROM golang:1.27 AS build-stage

WORKDIR /build

COPY ./ocb-config.yaml ocb-config.yaml

RUN go install go.opentelemetry.io/collector/cmd/builder@v0.160.0
# Allows symbolic-go's "-Wl,-rpath <dir>" cgo linker flag: matches "-Wl,-rpath" and its separate
# argument, the module's own lib/linux_<arch> directory.
ENV CGO_LDFLAGS_ALLOW='-Wl,-rpath|/go/pkg/mod/github.com/honeycombio/symbolic-go@[^/]+/lib/linux_[a-z0-9_]+'
RUN CGO_ENABLED=1 builder --config ocb-config.yaml

FROM gcr.io/distroless/cc

ARG USER_UID=10001
ARG USER_GID=10001
USER ${USER_UID}:${USER_GID}

COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chmod=755 --from=build-stage /build/otelcol-dev /otelcol
COPY --from=build-stage /go/pkg/mod/github.com/honeycombio/ /go/pkg/mod/github.com/honeycombio/

ENTRYPOINT ["/otelcol/otelcol-dev"]
CMD ["--config", "/etc/otelcol-contrib/config.yaml"]

EXPOSE 4317 4318 13133