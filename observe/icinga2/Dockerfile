FROM icinga/icinga2:2.15.3

# Instala dependências como root
USER root
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends gettext-base curl \
 && rm -rf /var/lib/apt/lists/*

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
