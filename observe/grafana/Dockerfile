FROM grafana/grafana:13.1.2@sha256:d177053ab62253815f130d81504f77063baf5fd4ca93299d6048453bd31e047a

USER root
RUN rm -rf \
    /usr/share/grafana/data/plugins-bundled/elasticsearch \
    /usr/share/grafana/data/plugins-bundled/zipkin
USER 472
