# R-Observe — Revisão de Segurança Enterprise

**Data**: 2026-06-15
**Classificação**: CONFIDENCIAL
**Versão**: 1.0

---

## Sumário

Revisão de segurança abrangendo APIs, containers, banco de dados, rede, autenticação e secrets management.

### Classificação Geral: **ALERTA** (4/10)

Múltiplas vulnerabilidades requerem correção antes de exposição pública ou uso em produção multi-tenant.

---

## 1. Autenticação e Sessão

### 1.1 [CRÍTICO] Sistema de Autenticação Dual

**Descrição**: Dois mecanismos de autenticação coexistem: session cookies (SHA256 token hash) e JWT RS256 interno. Ambos são implementados manualmente, sem uso de biblioteca de segurança estabelecida.

**Risco**: Inconsistência entre mecanismos, superfície de ataque expandida, falhas de implementação.

**Correção**: Unificar em `@results/auth` conforme `AUTH_ARCHITECTURE.md`.

### 1.2 [ALTO] Ausência de CSRF Protection

**Descrição**: Cookies de sessão (`observe_session`) não possuem token CSRF. O cookie é `sameSite: 'lax'`, o que mitiga parcialmente, mas não elimina o risco.

**Código afetado**:
```javascript
// api/src/middleware/auth.js:37-43
res.cookie(sessionCookieName, token, {
  httpOnly: true,
  sameSite: 'lax',
  secure,
  path: '/',
  expires: expiresAt,
});
```

**Correção**: Implementar CSRF token (double-submit cookie pattern ou header customizado).

### 1.3 [ALTO] Hash de Senha com Cost Factor Baixo

**Descrição**: `gen_salt('bf')` no PostgreSQL usa cost factor 6 por padrão. Para 2026, o mínimo recomendado é 10-12.

**Código afetado**:
```sql
-- api/src/index.js (rota POST /contacts)
convert_to(crypt($3::text, gen_salt('bf')), 'UTF8')
```

**Correção**: Usar `gen_salt('bf', 12)` ou migrar para Argon2id.

### 1.4 [MÉDIO] Sem Lockout de Conta

**Descrição**: Não há mecanismo de lockout após múltiplas tentativas de login falhas.

**Correção**: Implementar rate limiting por usuário no Redis com lockout após N tentativas.

### 1.5 [MÉDIO] Sem MFA

**Descrição**: Apenas user/password para autenticação.

**Correção**: Adicionar suporte a TOTP via `@results/auth`.

---

## 2. Autorização e RBAC

### 2.1 [ALTO] Discovery com Acesso Parcial Sem Auth

**Descrição**: `requireAuthOpt` permite acesso sem autenticação. Dados de topologia, assets e fingerprints podem vazar.

**Código afetado**:
```javascript
// discovery/src/index.js:103-112
const requireAuthOpt = (req, _res, next) => {
  const provided = req.headers['x-internal-token'] || ...;
  if (provided) {
    const payload = verifyInternalToken(provided);
    if (payload) req.auth = { ... };
  }
  next(); // ← sempre continua, mesmo sem token
};
```

**Correção**: Remover `requireAuthOpt` e exigir autenticação em todos os endpoints.

### 2.2 [MÉDIO] RBAC Binário

**Descrição**: Apenas 2 roles: `admin` e `operator`. Sem granularidade para auditoria, viewer, tenant-specific.

**Correção**: Implementar modelo RBAC com 4+ roles conforme `AUTH_ARCHITECTURE.md`.

### 2.3 [MÉDIO] Sem Row-Level Security

**Descrição**: Isolamento entre tenants é feito via `WHERE tenant_id = $1` nas queries, mas não há RLS no PostgreSQL.

**Correção**: Implementar RLS policies no PostgreSQL por tenant.

### 2.4 [BAIXO] Role Resolution Frágil

**Descrição**: Role é resolvida consultando `icingaweb_group_membership` com fallback entre esquemas (`group_id` vs `group_name`).

**Correção**: Centralizar role resolution em `@results/auth`.

---

## 3. API Security

### 3.1 [ALTO] Endpoints Públicos sem Autenticação

**Endpoints expostos**:
- `GET /observe/api/health` — versão e status
- `GET /observe/api/metrics` — métricas Prometheus
- `GET /health` (discovery) — status
- `GET /api/discovery/health` (discovery) — status
- `GET /metrics` (discovery) — métricas

**Correção**: Proteger `/metrics` com autenticação. Health pode permanecer público, mas sem detalhes.

### 3.2 [MÉDIO] Input Validation Básica

**Descrição**: Validação de input usa regex manual e `express.json({ limit: '512kb' })`. Sem schema validation (JSON Schema, Zod, Joi).

**Correção**: Implementar schema validation para todos os endpoints com entrada de usuário.

### 3.3 [MÉDIO] Rate Limiting em Memória

**Descrição**: `express-rate-limit` usa memória do processo, não Redis. Em múltiplas instâncias, limites são independentes.

**Correção**: Migrar para `rate-limit-redis` com Redis store.

### 3.4 [BAIXO] Helmet CSP Desabilitado

**Descrição**: `helmet({ contentSecurityPolicy: false })` — CSP desabilitado globalmente.

**Correção**: Configurar CSP adequado para a aplicação.

### 3.5 [MÉDIO] CORS Configurável mas Permissivo

**Descrição**: `cors({ origin: process.env.CORS_ORIGINS ? ... : false })` — quando não configurado, CORS é desabilitado (false = permite same-origin apenas). OK, mas documentação necessária.

---

## 4. Containers e Docker

### 4.1 [MÉDIO] Docker Socket Montado no Agent

**Descrição**: Agent tem acesso a `/var/run/docker.sock:ro`. Read-only mitiga risco de escape, mas ainda expõe informações de todos os containers.

**Correção**: Isolar agent em namespace ou usar Docker API proxy.

### 4.2 [BAIXO] Imagens sem Scan de Vulnerabilidades

**Descrição**: Não há evidência de scan de vulnerabilidades nas imagens Docker.

**Correção**: Integrar Trivy ou Docker Scout no pipeline de build.

### 4.3 [BAIXO] Container como root no docker-compose.dev.yml

**Descrição**: `docker-compose.observe.dev.yml` define `user: root` para API e discovery.

**Correção**: Manter non-root mesmo em dev, usando volumes com permissões corretas.

---

## 5. Secrets Management

### 5.1 [ALTO] Secrets em Variáveis de Ambiente

**Descrição**: Senhas, chaves JWT e API keys são passadas via environment variables nos containers.

**Correção**: Migrar para Docker secrets (já parcialmente implementado: `jwt_private`, `jwt_public`).

### 5.2 [MÉDIO] Docker Secrets Parciais

**Descrição**: Apenas chaves JWT usam Docker secrets. Senhas (DB_PASSWORD, REDIS_PASSWORD) ainda são environment variables.

**Correção**: Migrar todas as credenciais para Docker secrets.

### 5.3 [MÉDIO] `.env.dev` Referenciando INTERNAL_TOKEN

**Descrição**: `r-observe/.env.dev` usa `INTERNAL_TOKEN` enquanto o código espera `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`.

**Correção**: Padronizar nomes de variáveis.

---

## 6. Banco de Dados

### 6.1 [MÉDIO] Conexão sem TLS

**Descrição**: Sequelize conecta sem SSL/TLS ao PostgreSQL.

**Correção**: Habilitar TLS para conexões de banco ou documentar que é Acceptable Risk em rede Docker isolada.

### 6.2 [MÉDIO] SQL Injection — Análise

**Descrição**: Todas as queries usam parâmetros bind (`$1`, `$2`), o que previne SQL injection. **Nenhuma vulnerabilidade encontrada**.

**Status**: OK

### 6.3 [BAIXO] Conexão MariaDB Externa Hardcoded

**Descrição**: Referência a `10.10.2.99` (MariaDB) aparece em configurações, mas é externa ao escopo do R-Observe.

---

## 7. Rede

### 7.1 [MÉDIO] AI Service sem Autenticação Interna

**Descrição**: AI service depende exclusivamente de isolamento de rede Docker para segurança. Se a rede interna for comprometida, o serviço fica exposto.

**Correção**: Adicionar `requireJwt` em todas as rotas do AI service.

### 7.2 [BAIXO] Portas Expostas no Host

**Descrição**: PostgreSQL (5432) e Redis (6379) bindam em `127.0.0.1` — correto. Mas em dev, portas são expostas para acesso local.

---

## 8. Injeção e Path Traversal

### 8.1 [BAIXO] Path Traversal — Análise

**Descrição**: `express.static` é usado com paths fixos. Nenhum input de usuário controla paths de arquivos.

**Status**: OK

### 8.2 [BAIXO] Command Injection — Análise

**Descrição**: Agent executa `ping` e comandos de rede. Input é validado.

**Status**: OK

---

## 9. Logging e Auditoria

### 9.1 [MÉDIO] Sem Sanitização de Dados Sensíveis nos Logs

**Descrição**: Logs podem conter tokens, IPs e dados de usuário.

**Correção**: Implementar redação de dados sensíveis nos logs.

### 9.2 [BAIXO] Audit Log Implementado

**Descrição**: Tabela `observe_audit_log` e middleware de auditoria no discovery. API não tem auditoria equivalente.

**Status**: Expandir auditoria para API.

---

## 10. Resumo de Vulnerabilidades

| Severidade | Quantidade | Ação |
|---|---|---|
| Crítico | 2 | Correção imediata |
| Alto | 6 | Correção em 1 sprint |
| Médio | 12 | Correção em 2 sprints |
| Baixo | 8 | Melhoria contínua |

---

## 11. Checklist de correções

- [ ] **CSRF Protection**: Implementar double-submit cookie
- [ ] **Password Hash**: Migrar para `gen_salt('bf', 12)` ou Argon2id
- [ ] **Remover requireAuthOpt**: Exigir auth em todos os endpoints discovery
- [ ] **Account Lockout**: Implementar no Redis
- [ ] **Schema Validation**: JSON Schema em todos os endpoints
- [ ] **Rate Limit Redis**: Migrar de memória para Redis store
- [ ] **Docker Secrets**: Migrar DB_PASSWORD, REDIS_PASSWORD
- [ ] **CSP Header**: Configurar Content-Security-Policy
- [ ] **Vulnerability Scan**: Integrar Trivy no CI
- [ ] **Audit Log API**: Expandir middleware de auditoria
- [ ] **RLS PostgreSQL**: Implementar Row-Level Security
- [ ] **AI Service Auth**: Adicionar autenticação interna

---

*Documento gerado pela auditoria de segurança — 2026-06-15*
