FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS build

ARG ALLOY_VERSION=1.18.0
ARG ALLOY_ARCHIVE_SHA256=519de87a41d6b12a9377361e0d49c62bb07c3d7fbbb1c0a0e12810599bfca2f5

RUN apk add --no-cache curl tar \
    && curl -fsSL "https://github.com/grafana/alloy/archive/refs/tags/v${ALLOY_VERSION}.tar.gz" -o /tmp/alloy.tar.gz \
    && echo "${ALLOY_ARCHIVE_SHA256}  /tmp/alloy.tar.gz" | sha256sum -c - \
    && mkdir /source \
    && tar -xzf /tmp/alloy.tar.gz --strip-components=1 -C /source \
    && rm /tmp/alloy.tar.gz

WORKDIR /source
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go -C collector get golang.org/x/text@v0.39.0 \
    google.golang.org/grpc@v1.82.1 \
    && CGO_ENABLED=0 GOOS=linux go -C collector build -mod=mod -trimpath \
    -ldflags="-s -w -X github.com/grafana/alloy/internal/build.Version=${ALLOY_VERSION}" \
    -o /out/alloy .

FROM grafana/alloy:v1.18.0@sha256:491b0578c04983fd54fe99b587b6fab4404dc46d0dc16677bd6b00cc1140b308
COPY --from=build /out/alloy /bin/alloy
