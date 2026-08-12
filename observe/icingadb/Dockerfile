FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS build

ARG ICINGADB_VERSION=1.5.1
ARG ICINGADB_ARCHIVE_SHA256=006e63e983e599e789f91ec7a4b0425af1d2d036305e30f2d2028d18399b04c4

RUN apk add --no-cache curl tar \
    && curl -fsSL "https://github.com/Icinga/icingadb/archive/refs/tags/v${ICINGADB_VERSION}.tar.gz" -o /tmp/source.tar.gz \
    && echo "${ICINGADB_ARCHIVE_SHA256}  /tmp/source.tar.gz" | sha256sum -c - \
    && mkdir /source \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /source \
    && rm /tmp/source.tar.gz

WORKDIR /source
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/icingadb ./cmd/icingadb

FROM scratch
COPY --from=build /out/icingadb /bin/icingadb
COPY --from=build /source/schema /schema
USER 1001:1001
ENTRYPOINT ["/bin/icingadb"]
CMD ["--database-auto-import"]
