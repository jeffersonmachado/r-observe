# R-Observe — Icinga

## Stack Icinga

| Container              | Imagem                   | Função                                    |
|------------------------|--------------------------|-------------------------------------------|
| `r-observe-icinga2`      | build local (2.14)       | Motor de monitoramento (master node)      |
| `r-observe-icingadb`     | `icinga/icingadb:1.1`    | Sincronizacao Icinga2 → PostgreSQL        |
| `r-observe-icingaweb2`   | `icinga/icingaweb2:2.12` | Interface web                             |
| `r-observe-icinga-redis` | `redis:7-alpine`         | Buffer Redis dedicado do IcingaDB         |

## Variáveis de ambiente necessárias

Defina em `.env.observe` antes do deploy:

| Variável               | Obrigatório | Descrição                                 |
|------------------------|-------------|-------------------------------------------|
| `ICINGA_API_USER`      | sim         | Usuário da API (padrão: icingaweb2)       |
| `ICINGA_API_PASSWORD`  | sim         | Senha do usuário da API                   |
| `ICINGA_ROOT_PASSWORD` | não         | Senha root (omitir para não criar o user) |
| `ICINGA_REDIS_HOST`    | auto        | Host Redis IcingaDB (icinga-redis)        |
| `ICINGA_REDIS_PORT`    | auto        | Porta Redis (6379)                        |
| `ICINGADB_DB_NAME`     | sim         | Nome do banco IcingaDB (icingadb)         |
| `ICINGADB_DB_USER`     | sim         | Usuário do banco IcingaDB                 |
| `ICINGADB_DB_PASSWORD` | sim         | Senha do banco IcingaDB                   |
| `ICINGAWEB_ADMIN_USER` | sim         | Usuário admin do IcingaWeb2               |
| `ICINGAWEB_ADMIN_PASS` | sim         | Senha admin do IcingaWeb2                 |

## Primeiro acesso

```bash
cd /opt/results/r-observe

# 1. Subir o profile observe-icinga
docker compose -f docker-compose.observe.yml --env-file .env.observe \
  --profile observe-core --profile observe-icinga --profile r-observe-proxy up -d --build

# 2. Aguardar Icinga2 ficar healthy (~90s)
docker logs -f r-observe-icinga2

# 3. Acessar IcingaWeb2
#    http://localhost:3080/icinga/
#    Credenciais: ICINGAWEB_ADMIN_USER / ICINGAWEB_ADMIN_PASS

# 4. Verificar API Icinga2
docker exec r-observe-icinga2 curl -sk \
  -u "${ICINGA_API_USER}:${ICINGA_API_PASSWORD}" \
  https://127.0.0.1:5665/v1/status/IcingaApplication | python3 -m json.tool
```

## Descoberta automática de hosts

O script `scripts/observe/discover-hosts.sh` varre a rede local (usando `nmap`),
detecta serviços por porta e registra os hosts diretamente via Icinga2 REST API
sem precisar reiniciar o container.

```bash
# Pré-requisito: nmap instalado no host
# sudo apt install nmap   (Ubuntu/Debian)
# sudo dnf install nmap   (RHEL/AlmaLinux)

# Descoberta na subnet padrão (auto-detectada)
./scripts/observe/discover-hosts.sh

# Subnet específica (dry-run primeiro)
./scripts/observe/discover-hosts.sh --subnet 10.10.2.0/24 --dry-run
./scripts/observe/discover-hosts.sh --subnet 10.10.2.0/24

# Listar hosts registrados
./scripts/observe/discover-hosts.sh --list

# Remover host
./scripts/observe/discover-hosts.sh --remove host-10-10-2-30
```

### Serviços detectados automaticamente

| Porta | Serviço registrado | Var do host         |
|-------|--------------------|---------------------|
| 22    | SSH                | `vars.os = "Linux"` |
| 25    | SMTP               | `vars.smtp_port`    |
| 80    | HTTP               | `vars.http_vhosts`  |
| 143   | IMAP               | `vars.imap_port`    |
| 443   | HTTPS              | `vars.http_vhosts`  |
| 465   | SMTPS (TCP)        | `vars.smtp_tls_port`|
| 587   | Submission         | `vars.smtp_submission_port` |
| 993   | IMAPS (TCP)        | `vars.imaps_port`   |
| 995   | POP3S (TCP)        | `vars.pop3s_port`   |
| 8080  | HTTP alt           | `vars.http_vhosts`  |
| 11334 | rspamd UI          | `vars.check_rspamd` |

### Adicionar host manualmente

```bash
# Via API (sem restart)
docker exec r-observe-icinga2 curl -sk \
  -u "${ICINGA_API_USER}:${ICINGA_API_PASSWORD}" \
  -X PUT -H "Accept: application/json" \
  https://127.0.0.1:5665/v1/objects/hosts/meu-servidor \
  -d '{
    "templates": ["generic-host"],
    "attrs": {
      "address": "10.10.2.1",
      "display_name": "meu-servidor",
      "check_command": "hostalive",
      "vars": { "os": "Linux", "smtp_port": 25 }
    }
  }'
```

## Integração com R-Observe

### Fluxo de notificação

```
Icinga2 detecta problema
  → r-observe-notify.sh (conf.d/r-observe-notify.conf)
      → POST /observe/api/icinga/events
          → Redis queue (observe:events:icinga)
              → r-observe-worker cria incidente
                  → r-observe-ai analisa
```

O script `observe/icinga2/r-observe-notify.sh` é copiado para
`/usr/lib/r-observe/notify.sh` na imagem e chamado pelo
`NotificationCommand "r-observe-notify"` definido em
`conf.d/r-observe-notify.conf.tpl`.

Credenciais usadas: `ICINGA_API_PASSWORD` (injetado via `envsubst`
no entrypoint antes do start do daemon).

### Tipos de evento gerados

| Estado Icinga2          | Tipo de evento R-Observe   |
|-------------------------|---------------------------|
| HOST DOWN               | `host.down`               |
| HOST UP (recovery)      | `host.recovery`           |
| SERVICE CRITICAL        | `service.critical`        |
| SERVICE WARNING         | `service.warning`         |
| SERVICE OK (recovery)   | `service.recovery`        |

Eventos de recovery fecham automaticamente os incidentes abertos
do host correspondente no banco `observe_incidents`.

### Verificar notificações recebidas

```bash
TOKEN=$(grep OBSERVE_INTERNAL_TOKEN .env.observe | cut -d= -f2)

# Incidentes com source=icinga
curl -sf http://localhost:3080/observe/api/incidents \
  -H "x-internal-token: $TOKEN" | \
  python3 -c "
import json,sys
data=json.load(sys.stdin)
for i in data['incidents']:
  if i.get('source')=='icinga':
    print(i['title'], '|', i['severity'], '|', i['status'])
"
```

## Configuração dos checks de e-mail

Os apply rules para SMTP, IMAP, etc. estão em
`conf.d/mail-services.conf`. Eles são ativados automaticamente
pelas variáveis do host (definidas pelo `discover-hosts.sh`
ou manualmente via API).

## Usuário root da API

O usuário `root` (permissões totais) **só é criado** se
`ICINGA_ROOT_PASSWORD` estiver definido e não-vazio no `.env.observe`.
Se omitido, apenas o usuário `ICINGA_API_USER` existe.

## Módulo IcingaDB no IcingaWeb2

A configuração do módulo (conexão Redis + PostgreSQL) é gerada
automaticamente pelo entrypoint da imagem `icinga/icingaweb2:2.12`
a partir das variaveis de ambiente do servico `r-observe-icingaweb2` no
`docker-compose.observe.yml`. Nenhuma configuração manual na UI é necessária.
