FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS entrypoint-build

ARG ICINGA_DOCKER_COMMIT=e059eccf16fcbb6b36079ea54158a0341765ce06
ARG ICINGA_DOCKER_ARCHIVE_SHA256=df974f101e514c19c16c13c6740fffeee32b21ef5c41e03606a2bd0e0e6e37b2

RUN apk add --no-cache curl tar \
 && curl -fsSL "https://github.com/Icinga/docker-icinga2/archive/${ICINGA_DOCKER_COMMIT}.tar.gz" -o /tmp/source.tar.gz \
 && echo "${ICINGA_DOCKER_ARCHIVE_SHA256}  /tmp/source.tar.gz" | sha256sum -c - \
 && mkdir /source \
 && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /source \
 && rm /tmp/source.tar.gz

WORKDIR /source/entrypoint
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/entrypoint .

FROM icinga/icinga2:2.16.4@sha256:51e8699e2d0de5a9eaee2b70b3abd84453f2810f30743dfa82e953d8453bf52b

# Instala dependências como root
USER root
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
 && apt-get install -y --no-install-recommends gettext-base curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=entrypoint-build /out/entrypoint /entrypoint

# Dá acesso ao Docker socket (grupo docker no host tem GID 137)
RUN groupadd -g 137 docker 2>/dev/null; usermod -aG docker icinga 2>/dev/null; true

RUN mkdir -p /observe-conf.d /usr/lib/r-observe

COPY conf.d/            /observe-conf.d/
COPY --chmod=755 r-observe-notify.sh  /usr/lib/r-observe/notify.sh
COPY --chmod=755 observe-init.sh      /observe-init.sh
COPY --chmod=755 auto-attach-networks.sh /usr/local/bin/auto-attach-networks.sh

# Restaura usuário original da imagem base (icinga, uid=5665)
# para que o entrypoint binário funcione com as permissões corretas
USER icinga

CMD ["/observe-init.sh"]
