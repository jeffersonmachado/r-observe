FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS build

ARG LOKI_VERSION=3.7.2
ARG LOKI_ARCHIVE_SHA256=f91b7737cc0ca352dfb99e9307bc2f6a67135d6827922374ab4a31676d280790

RUN apk add --no-cache curl tar \
    && curl -fsSL "https://github.com/grafana/loki/archive/refs/tags/v${LOKI_VERSION}.tar.gz" -o /tmp/loki.tar.gz \
    && echo "${LOKI_ARCHIVE_SHA256}  /tmp/loki.tar.gz" | sha256sum -c - \
    && mkdir /source \
    && tar -xzf /tmp/loki.tar.gz --strip-components=1 -C /source \
    && rm /tmp/loki.tar.gz

WORKDIR /source
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go get github.com/apache/thrift@v0.23.0 \
    golang.org/x/crypto@v0.53.0 \
    golang.org/x/net@v0.56.0 \
    golang.org/x/text@v0.39.0 \
    google.golang.org/grpc@v1.82.1 \
    && CGO_ENABLED=0 GOOS=linux go build -mod=mod -trimpath \
    -ldflags="-s -w -X github.com/grafana/loki/v3/pkg/util/build.Version=${LOKI_VERSION}" \
    -o /out/loki ./cmd/loki

FROM grafana/loki:3.7.2@sha256:191d4fdfb7264f16989f0a57f320872620a5a7c2ceeec6229212c4190ec49b86
COPY --from=build /out/loki /usr/bin/loki
