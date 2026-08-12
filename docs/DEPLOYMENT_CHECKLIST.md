# R-Observe — Deployment Checklist

## Pré-requisitos

- [ ] Docker 20.10+ instalado
- [ ] Docker Compose plugin instalado
- [ ] 4GB+ RAM, 2+ CPU cores, 20GB+ disco
- [ ] Portas 3080, 5432, 6379 disponíveis
- [ ] `bash installer/validate.sh` executado com sucesso

## Instalação Inicial

```bash
# 1. Validar ambiente
sudo bash installer/validate.sh

# 2. Instalar
sudo bash installer/install.sh \
  --admin-user admin \
  --admin-pass 'SenhaSegura123!' \
  --accept-eula

# 3. Verificar saúde
curl http://localhost:3080/observe/api/health
```

## Pós-Instalação

- [ ] Acessar `http://<host>:3080/observe/login` e fazer login
- [ ] Configurar provider AI em `/observe/settings`
- [ ] Executar primeiro scan de discovery: `npm run observe:discover:engine:scan`
- [ ] Verificar se Prometheus está coletando métricas: `http://<host>:9090/targets`
- [ ] Verificar Grafana: `http://<host>:3001` (admin/admin)
- [ ] Importar dashboard "R-Observe Health"

## Configuração de Produção

### Secrets
- [ ] Gerar o keyring M2M: `scripts/observe/jwt-keys.sh init`
- [ ] Confirmar os cinco pares com `scripts/observe/jwt-keys.sh show`
- [ ] Verificar permissões: privadas `0600`, públicas `0644`, diretório `0700`
- [ ] Confirmar Docker secrets separados para API, Worker, Agent, Discovery e automação
- [ ] Alterar senhas padrão no `.env.observe`
- [ ] Configurar `OBSERVE_CORS_ORIGINS` para domínio de produção

### AI
- [ ] Configurar API key OpenAI/Anthropic/DeepSeek em `/observe/settings`
- [ ] Ajustar `REMEDIATION_AUTO_THRESHOLD` (default: 0.85)
- [ ] Revisar catálogo de remediações em `/observe/api/ai/catalog`

### Discovery
- [ ] Configurar SNMP community strings em `DISCOVERY_SNMP_COMMUNITIES`
- [ ] Configurar ranges de scan em `DISCOVERY_SCAN_RANGES`
- [ ] Habilitar cloud scanners se aplicável:
  - AWS: `DISCOVERY_CLOUD_AWS_ENABLED=true` + credenciais AWS CLI
  - Azure: `DISCOVERY_CLOUD_AZURE_ENABLED=true` + `az login`
- [ ] Habilitar VMware: `DISCOVERY_VMWARE_ENABLED=true` + credenciais
- [ ] Habilitar Proxmox: `DISCOVERY_PROXMOX_ENABLED=true` + credenciais

### Monitoramento
- [ ] Configurar alertas no Icinga2
- [ ] Configurar notificações (email, Slack, webhook)
- [ ] Ajustar thresholds de alerta

### Backup
- [ ] Agendar backup diário: `0 3 * * * /opt/results/r-observe/installer/backup.sh`
- [ ] Testar restore em ambiente separado

## Upgrade

```bash
# 1. Backup pre-upgrade
sudo bash installer/backup.sh --pre-upgrade

# 2. Atualizar código (git pull ou extrair novo zip)
cd /opt/results/ria/r-observe && git pull

# 3. Upgrade
sudo bash installer/upgrade.sh

# 4. Verificar saúde pós-upgrade
curl http://localhost:3080/observe/api/health
docker compose -f docker-compose.observe.yml --env-file .env.observe ps
```

## Troubleshooting

### API não inicia
```bash
docker compose -f docker-compose.observe.yml --env-file .env.observe logs r-observe-api
# Verificar: DB_PASSWORD, JWT keys, Redis connectivity
```

### Discovery não encontra hosts
```bash
# Verificar se SNMP está habilitado e community string correta
docker compose -f docker-compose.observe.yml --env-file .env.observe logs r-observe-discovery
```

### AI não responde
```bash
docker compose -f docker-compose.observe.yml --env-file .env.observe logs r-observe-ai
# Verificar: AI_PROVIDER, API key, conectividade com internet
```

### Prometheus sem targets
```bash
# Verificar SD endpoint
curl http://localhost:3080/observe/api/sd/targets
```

## Migrations

```bash
# Listar migrations executadas
docker exec r-observe-api node -e "
  const {runMigrations}=require('./src/migrate');
  runMigrations({query:async()=>{}}).catch(()=>{});
"

# Executar migration específica manualmente
docker exec -i r-observe-postgres psql -U observe observedb < migrations/017_csrf_protection.sql
```

## Rollback

```bash
# Parar e remover (mantém volumes)
sudo bash installer/uninstall.sh

# Parar e remover tudo (--purge)
sudo bash installer/uninstall.sh --purge
```
