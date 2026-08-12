FROM composer:2@sha256:4d71c3c2109c61d5415544264b59ad4087e4c5b7244481723664138fd36d5040 AS composer

FROM icinga/icingaweb2:2.14@sha256:b5ffc8cbedf81f6f64bcb8e604508b2c0b1ac20a18bf220a112d54c2e707f8df

# A imagem upstream pode anteceder correções publicadas pelo Debian.
# Atualiza apenas pacotes da distribuição, preservando a aplicação e o
# entrypoint oficiais do IcingaWeb2.
USER root
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && composer update guzzlehttp/guzzle --with-all-dependencies --no-dev --no-interaction --no-progress --working-dir=/usr/share/icinga-php/vendor \
    && rm -rf /usr/share/icingaweb2/modules/aws \
    && rm -f /usr/local/bin/composer
