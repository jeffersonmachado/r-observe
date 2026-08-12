/*
 * Healthcheck HTTP leve (imagens distroless/minimalistas sem shell/wget/curl).
 * Faz um GET simples e verifica se o corpo contém uma substring esperada.
 *
 * Uso:
 *   healthcheck <ip> <porta> <caminho> <substring-esperada>
 *
 * Exemplos:
 *   otel-collector: healthcheck 127.0.0.1 13133 / "Server available"
 *   grafana alloy:   healthcheck 127.0.0.1 12345 /-/healthy "healthy"
 *
 * Compilar estatico (x86_64, roda na imagem scratch):
 *   gcc -static -O2 -s -o healthcheck healthcheck.c
 */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 5) {
        fprintf(stderr, "uso: %s <ip> <porta> <caminho> <substring>\n", argv[0]);
        return 2;
    }

    const char *ip = argv[1];
    int port = atoi(argv[2]);
    const char *path = argv[3];
    const char *needle = argv[4];

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 1;

    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons((unsigned short)port);
    if (inet_pton(AF_INET, ip, &a.sin_addr) != 1) { close(fd); return 1; }

    if (connect(fd, (struct sockaddr *)&a, sizeof(a)) != 0) { close(fd); return 1; }

    char req[1024];
    int reqlen = snprintf(req, sizeof(req),
        "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n", path, ip);
    if (reqlen < 0 || reqlen >= (int)sizeof(req)) { close(fd); return 1; }
    if (send(fd, req, reqlen, 0) < 0) { close(fd); return 1; }

    char buf[8192];
    int total = 0;
    for (;;) {
        int n = recv(fd, buf + total, sizeof(buf) - 1 - total, 0);
        if (n <= 0) break;
        total += n;
        if (total >= (int)sizeof(buf) - 1) break;
    }
    close(fd);

    buf[total] = '\0';
    return strstr(buf, needle) ? 0 : 1;
}
