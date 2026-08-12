/*
 * Healthcheck leve para o OpenTelemetry Collector (imagem distroless, sem shell).
 * Consulta o endpoint da extensao `health_check` (http://127.0.0.1:13133/) que
 * responde "Server available" quando o coletor esta saudavel.
 *
 * Compilar estatico (x86_64, compatível com a imagem scratch):
 *   gcc -static -O2 -s -o healthcheck healthcheck.c
 */
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 1;

    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons(13133);
    if (inet_pton(AF_INET, "127.0.0.1", &a.sin_addr) != 1) { close(fd); return 1; }

    if (connect(fd, (struct sockaddr *)&a, sizeof(a)) != 0) { close(fd); return 1; }

    const char req[] = "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n";
    if (send(fd, req, sizeof(req) - 1, 0) < 0) { close(fd); return 1; }

    char buf[2048];
    int total = 0;
    for (;;) {
        int n = recv(fd, buf + total, sizeof(buf) - 1 - total, 0);
        if (n <= 0) break;
        total += n;
        if (total >= (int)sizeof(buf) - 1) break;
    }
    close(fd);

    buf[total] = '\0';
    return strstr(buf, "Server available") ? 0 : 1;
}
