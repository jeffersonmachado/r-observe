FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS gosu-build

ARG GOSU_VERSION=1.19
ARG GOSU_ARCHIVE_SHA256=cd9719b775dbfedae53923c9b0dc792b66d42c51e0b36652ed6f747fbadc0164

RUN apk add --no-cache curl tar \
    && curl -fsSL "https://github.com/tianon/gosu/archive/refs/tags/${GOSU_VERSION}.tar.gz" -o /tmp/source.tar.gz \
    && echo "${GOSU_ARCHIVE_SHA256}  /tmp/source.tar.gz" | sha256sum -c - \
    && mkdir /source \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /source \
    && rm /tmp/source.tar.gz

WORKDIR /source
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/gosu .

FROM postgres:16.14-alpine3.24@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
COPY --from=gosu-build /out/gosu /usr/local/bin/gosu
