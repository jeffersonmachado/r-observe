FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS build

ARG SNMP_EXPORTER_VERSION=0.30.1
ARG SNMP_EXPORTER_ARCHIVE_SHA256=337eef46f6c5495c97df80ae6e378521db93da0f8603ef7cffea727075b08d39

RUN apk add --no-cache curl tar \
    && curl -fsSL "https://github.com/prometheus/snmp_exporter/archive/refs/tags/v${SNMP_EXPORTER_VERSION}.tar.gz" -o /tmp/source.tar.gz \
    && echo "${SNMP_EXPORTER_ARCHIVE_SHA256}  /tmp/source.tar.gz" | sha256sum -c - \
    && mkdir /source \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /source \
    && rm /tmp/source.tar.gz

WORKDIR /source
RUN go get golang.org/x/net@v0.55.0 \
    golang.org/x/crypto@v0.52.0 \
    golang.org/x/text@v0.39.0 \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w \
      -X github.com/prometheus/common/version.Version=${SNMP_EXPORTER_VERSION} \
      -X github.com/prometheus/common/version.Revision=48b810afbd9222b74439ad1cf7d0b7c0cf4290 \
      -X github.com/prometheus/common/version.Branch=HEAD \
      -X github.com/prometheus/common/version.BuildUser=r-observe" \
    -o /out/snmp_exporter .

FROM scratch
COPY --from=build /out/snmp_exporter /bin/snmp_exporter
USER 65534:65534
EXPOSE 9116
ENTRYPOINT ["/bin/snmp_exporter"]
