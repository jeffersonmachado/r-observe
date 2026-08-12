FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS build

ARG POSTGRES_EXPORTER_VERSION=0.20.1
ARG POSTGRES_EXPORTER_ARCHIVE_SHA256=be5d9b71cdedcc5bd484869a2a1c66e51f76d5620ebf681781f22acc0cba283b

RUN apk add --no-cache curl tar \
    && curl -fsSL "https://github.com/prometheus-community/postgres_exporter/archive/refs/tags/v${POSTGRES_EXPORTER_VERSION}.tar.gz" -o /tmp/source.tar.gz \
    && echo "${POSTGRES_EXPORTER_ARCHIVE_SHA256}  /tmp/source.tar.gz" | sha256sum -c - \
    && mkdir /source \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /source \
    && rm /tmp/source.tar.gz

WORKDIR /source
RUN go get golang.org/x/text@v0.39.0 \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w \
      -X github.com/prometheus/common/version.Version=${POSTGRES_EXPORTER_VERSION} \
      -X github.com/prometheus/common/version.Revision=867fbcac31cd18c143e244190ea9168cca069827 \
      -X github.com/prometheus/common/version.Branch=HEAD \
      -X github.com/prometheus/common/version.BuildUser=r-observe \
      -X github.com/prometheus/common/version.BuildDate=20260707-21:44:40" \
    -o /out/postgres_exporter ./cmd/postgres_exporter

COPY healthcheck.go /healthcheck.go
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/healthcheck /healthcheck.go

FROM scratch
COPY --from=build /out/postgres_exporter /bin/postgres_exporter
COPY --from=build /out/healthcheck /bin/healthcheck
USER 65534:65534
EXPOSE 9187
ENTRYPOINT ["/bin/postgres_exporter"]
