# Correção do Servidor de Email — 09/06/2026

## Sumário

Diagnóstico e correção completa do servidor de email `results.com.br` (Roundcube + Postfix + Dovecot + MariaDB + LDAP).
12 problemas encontrados e corrigidos. Servidor validado com envio e recebimento funcionais.

---

## 1. Diagnóstico Inicial

### Sintomas
- Webmail acessível em `https://results.com.br/webmail/`
- Login funcionava (IMAP OK)
- **Envio de email falhava** com `Erro SMTP (535): Falha na autenticação`

### Causas Raiz Identificadas

| # | Componente | Problema | Impacto |
|---|-----------|----------|---------|
| 1 | Postfix → Dovecot SASL | `smtpd_sasl_path = inet:dovecot:12345` — hostname `dovecot` não resolvível no container | SMTP AUTH quebrado |
| 2 | Postfix → Dovecot LMTP | `virtual_transport = lmtp:inet:dovecot:24` — mesmo problema | Entrega local quebrada |
| 3 | Postfix → LDAP | `bind_dn = cn=administrador,...` — DN incorreto (`cn=admin` é o correto) | Virtual alias maps quebrado |
| 4 | Postfix → LDAP | `server_host = 10.10.2.10 10.10.2.7` — servidores antigos inacessíveis | Lookup LDAP falhava |
| 5 | Dovecot → MariaDB | Hash `8W7aW8GaKF1xI` não correspondia a `jcm@1970` | Autenticação Dovecot falhava |
| 6 | Roundcube → MySQL | Conexão sem SSL — MariaDB exige TLS | `DATABASE ERROR: CONNECTION FAILED` |
| 7 | Roundcube → Postfix | `tls://` (STARTTLS) na porta 587 — incompatibilidade de protocolo | SMTP 454/535 |
| 8 | Joomla | DNS `mx1.results.com.br` → IP virtual `10.10.2.3` inacessível do container | Roundcube não conectava ao SMTP |
| 9 | Joomla | DNS `dovecot` não resolvível (Dovecot em modo host) | Roundcube não conectava ao IMAP |
| 10 | Joomla | Fora da rede `infra-httpd_default` | Proxy Apache retornava 503 |
| 11 | Postfix | Fora da rede `infra-mail_default` | Sem acesso ao Dovecot (host) |
| 12 | Postfix | Volume `infra_mail-certs` vs `infra-mail_mail-certs` — nomes diferentes | Postfix não iniciava (sem certs) |

---

## 2. Correções Aplicadas

### 2.1 Containers em Execução (Hotfix)

```bash
# mx1 e mx2: corrigir SASL, LMTP e LDAP
docker exec results-mail-postfix sed -i \
  's|inet:dovecot:12345|inet:172.27.0.1:12345|' /etc/postfix/main.cf
docker exec results-mail-postfix sed -i \
  's|lmtp:inet:dovecot:24|lmtp:inet:172.27.0.1:24|g' /etc/postfix/main.cf
docker exec results-mail-postfix sed -i \
  's|cn=administrador|cn=admin|' /etc/postfix/ldap_virtual_alias_maps.cf
docker exec results-mail-postfix sed -i \
  's|10.10.2.10 10.10.2.7|172.27.0.8|' /etc/postfix/ldap_virtual_alias_maps.cf

# mx2: mesmas correções
docker exec results-mail-postfix-mx2 ... (idêntico)

# Joomla: DNS
docker exec results-joomla sh -c \
  'echo "172.28.0.3 mx1.results.com.br mx2.results.com.br" >> /etc/hosts'
docker exec results-joomla sh -c \
  'echo "172.27.0.1 dovecot imap.results.com.br" >> /etc/hosts'

# Proxy: DNS
docker exec secure-httpd sh -c 'echo "172.25.0.5 joomla" >> /etc/hosts'

# Redes
docker network connect infra-mail_default results-mail-postfix
docker network connect infra-mail_default results-mail-postfix-mx2
docker network connect infra-httpd_default results-joomla

# Certificados
cp /var/lib/docker/volumes/infra-mail_mail-certs/_data/* \
   /var/lib/docker/volumes/infra_mail-certs/_data/

# Senha MariaDB
mariadb -h 10.10.2.99 -u resultsdba -p'resu1@@dba' \
  --ssl-verify-server-cert=0 results -e \
  "UPDATE mailbox SET password='\$6\$.YN2m0QLHlGAFEFO\$cjN/d8t91qdUbwUnFcpBiejgSPRT.Qwm4H97wJoMZL6wBomiRkOwhdRZ1HmZzsdchjUhhOmiUTlKr1BQAVdh31' WHERE username='jefferson@results.com.br';"
```

### 2.2 Arquivos Fonte (Persistência)

#### `/opt/results/infra/mail/postfix/main.cf.template`
```
smtpd_sasl_path = inet:${DOVECOT_HOST}:12345   # antes: inet:dovecot:12345
mailbox_transport = lmtp:inet:${DOVECOT_HOST}:24
virtual_transport = lmtp:inet:${DOVECOT_HOST}:24
```

#### `/opt/results/infra/docker-compose.mail.yml`
```yaml
# Adicionado aos serviços postfix e postfix-mx2:
networks:
  - default
  - mail-backend

# Adicionado env var:
DOVECOT_HOST: ${DOVECOT_HOST:-172.27.0.1}

# Corrigido default:
LDAP_BIND_DN: ${LDAP_BIND_DN:-cn=admin,dc=results,dc=com,dc=br}  # era cn=administrador
```

#### `/opt/results/infra/docker-compose.yml`
```yaml
# Adicionado ao serviço joomla:
networks:
  default:
  mail-backend:
  httpd:                           # NOVO

# Adicionado ao final:
networks:
  httpd:
    external: true
    name: ${HTTPD_NETWORK:-infra-httpd_default}
```

#### `/opt/results/infra/joomla/docker-entrypoint.sh`
```bash
# NOVO: Resolve Dovecot via gateway (host mode)
dovecot_ip=$(ip route 2>/dev/null | grep default | awk '{print $3}' | head -1)
if [ -n "$dovecot_ip" ]; then
    sed -i "/dovecot/d" /etc/hosts 2>/dev/null || true
    echo "$dovecot_ip dovecot imap.results.com.br" >> /etc/hosts
fi

# EXISTENTE: Resolve postfix/postfix-mx2 via DNS Docker
for svc in postfix postfix-mx2; do
    ip=$(getent hosts "$svc" 2>/dev/null | awk '{print $1}' | head -1)
    ...
done
```

#### `/opt/results/infra/roundcube/config.inc.php`
```php
// SMTP: tls:// → ssl:// (usa SMTPS porta 465 em vez de STARTTLS 587)
$config['smtp_server'] = getenv('ROUNDCUBE_SMTP_SERVER') ?: 'ssl://mx1.results.com.br';

// MySQL: adicionado SSL
$config['db_dsnw'] = 'mysql://roundcube:' . ... . '/roundcubemail?ssl=1&ssl_verify=0';
```

#### `/opt/results/infra/.env.remote-10.10.2.30-mail`
```ini
LDAP_URI=ldap://ldap                          # era: ldap://10.10.2.10,ldap://10.10.2.7
LDAP_BIND_DN=cn=admin,dc=results,dc=com,dc=br # era: cn=administrador,...
DOVECOT_HOST=172.27.0.1                       # NOVO
```

#### `/opt/results/infra/.env.mail.example`
```ini
LDAP_URI=ldap://ldap
LDAP_BIND_DN=cn=admin,dc=results,dc=com,dc=br
```

---

## 3. Arquitetura de Rede

```
┌─────────────────────────────────────────────────────┐
│ Host Docker (10.10.2.30)                            │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Dovecot  │  │ Postfix  │  │ Postfix MX2      │  │
│  │ (host)   │  │ mx1      │  │                  │  │
│  │          │  │          │  │ redes:           │  │
│  │ portas:  │  │ redes:   │  │  default         │  │
│  │ 993 IMAP │  │  default │  │  mail-backend    │  │
│  │ 12345    │  │  mail-   │  │                  │  │
│  │  SASL    │  │  backend │  │                  │  │
│  │ 24 LMTP  │  │          │  │                  │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│       ▲              ▲                               │
│       │              │                               │
│  ┌────┴──────────────┴──────────────────────────┐   │
│  │ Joomla (Roundcube)                           │   │
│  │ redes: default, mail-backend, httpd          │   │
│  │ /etc/hosts dinâmico via entrypoint:          │   │
│  │   mx1.results.com.br → DNS(postfix)          │   │
│  │   dovecot → gateway Docker                   │   │
│  └────────────────────┬─────────────────────────┘   │
│                       │                             │
│  ┌────────────────────┴─────────────────────────┐   │
│  │ secure-httpd (Apache Proxy)                  │   │
│  │ rede: httpd                                  │   │
│  │ /etc/hosts: joomla → 172.25.0.5              │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌──────────┐  ┌──────────────────────────────────┐ │
│  │ MariaDB  │  │ LDAP (results-mail-ldap)         │ │
│  │10.10.2.99│  │ rede: mail-backend (172.27.0.8)  │ │
│  └──────────┘  └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Conectividade entre containers

| De | Para | Via | Porta |
|----|------|-----|-------|
| Joomla | Postfix | `mx1.results.com.br` (DNS) | 465 (SMTPS) |
| Joomla | Dovecot | Gateway Docker (172.27.0.1) | 993 (IMAP) |
| Postfix | Dovecot SASL | Gateway Docker (172.27.0.1) | 12345 |
| Postfix | Dovecot LMTP | Gateway Docker (172.27.0.1) | 24 |
| Postfix | LDAP | `ldap` (DNS Docker) | 389 |
| Postfix | MariaDB | 10.10.2.99 | 3306 |
| Joomla | MariaDB | 10.10.2.99 (roundcube) / 10.10.2.79 (roundcubemail) | 3306 |
| secure-httpd | Joomla | `joomla` (/etc/hosts) | 80 |

---

## 4. Verificação

### Comandos de teste

```bash
# Teste IMAP
openssl s_client -connect 10.10.2.30:993 -quiet

# Teste SMTP SMTPS
openssl s_client -connect mx1.results.com.br:465 -quiet

# Teste auth Dovecot
docker exec results-mail-dovecot doveadm auth test jefferson@results.com.br jcm@1970

# Verificar entrega
docker logs results-mail-postfix --since 10m | grep 'status=sent'
```

### Evidência de entrega

```
postfix/lmtp: to=<jefferson@results.com.br>,
relay=172.27.0.1[172.27.0.1]:24, dsn=2.0.0, status=sent
(250 2.0.0 <jefferson@results.com.br> ... Saved)
```

---

## 5. Notas para Rebuild

Ao executar `docker compose up` para recriar os containers:

1. O **certificado** pode precisar ser copiado se o nome do projeto for diferente:
   ```bash
   cp /var/lib/docker/volumes/infra-mail_mail-certs/_data/* \
      /var/lib/docker/volumes/infra_mail-certs/_data/
   ```
   > Isso ocorre porque o deploy manual usou project name `infra` em vez de `infra-mail`.

2. O **volume do Joomla** (`infra_joomla-site-data`) pode estar vazio após rebuild.
   O lsyncd (`joomla-lsyncd`) sincroniza de `/opt/results/infra/joomla-site/`.
   Se necessário, forçar sincronia ou copiar do volume `infra-httpd_joomla-site-data`.

3. O **hash da senha** no MariaDB é persistente e não precisa ser reaplicado.

4. As **entradas em /etc/hosts** do secure-httpd (`joomla`) precisam ser recriadas manualmente
   ou persistidas no docker-compose como `extra_hosts`.

---

## 6. Credenciais de Teste

| Serviço | Usuário | Senha |
|---------|---------|-------|
| Webmail | `jefferson` | `jcm@1970` |
| MySQL (resultsdba) | `resultsdba` | `resu1@@dba` |
| MySQL (roundcube) | `roundcube` | `resu100roundcube` |
| LDAP Admin | `cn=admin,dc=results,dc=com,dc=br` | `resu100vsza` |

---

**Data**: 09/06/2026
**Responsável**: Correção automatizada via AI (GitHub Copilot)
