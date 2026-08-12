# R-Observe — Arquitetura de Autenticação e Autorização

**Versão**: 1.0
**Data**: 2026-06-15
**Status**: JWT M2M migrado para `@results/auth`; sessões humanas ainda em consolidação

---

## 1. Resumo Executivo

O R-Observe está em processo de migração de um sistema de autenticação dual (session cookies + JWT interno) para autenticação centralizada via `@results/auth`. Este documento descreve o estado atual, o estado alvo e o plano de migração.

---

## 2. Arquitetura Atual (Legado — Em descontinuação)

### 2.1 Diagrama de Fluxo Atual

```
┌──────────────────────────────────────────────────────────────────────┐
│                    AUTENTICAÇÃO ATUAL (DUAL)                         │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Usuário (Browser)                                                   │
│       │                                                              │
│       │ POST /observe/api/auth/login {user, password}                │
│       ▼                                                              │
│  ┌─────────────────────────────────────────────┐                     │
│  │              API (index.js)                  │                     │
│  │                                              │                     │
│  │  1. Valida credenciais via pgcrypto crypt() │                     │
│  │  2. Gera token: crypto.randomBytes(32)      │                     │
│  │  3. SHA256(token) → token_hash              │                     │
│  │  4. INSERT observe_sessions                  │                     │
│  │  5. Set-Cookie: observe_session=<token>      │                     │
│  │  6. Resolve role via icingaweb_group          │                     │
│  └─────────────────────────────────────────────┘                     │
│                                                                      │
│  Serviço Interno (M2M)                                              │
│       │                                                              │
│       │ Header: x-internal-token: <JWT RS256>                        │
│       ▼                                                              │
│  ┌─────────────────────────────────────────────┐                     │
│  │           jwt.js (RS256)                     │                     │
│  │                                              │                     │
│  │  signInternalToken(claims) → assina com     │                     │
│  │    JWT_PRIVATE_KEY (RS256, 5min expiry)      │                     │
│  │                                              │                     │
│  │  verifyInternalToken(token) → verifica com  │                     │
│  │    JWT_PUBLIC_KEY                            │                     │
│  │                                              │                     │
│  │  requireJwt(req, res, next) → middleware     │                     │
│  └─────────────────────────────────────────────┘                     │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Mecanismos Existentes

| Mecanismo | Uso | Fraquezas |
|---|---|---|
| **Session Cookie** (`observe_session`) | Browser → API | Sem CSRF, token hasheado com SHA256 (one-way, não revogável individualmente sem DB) |
| **JWT RS256 interno** (`x-internal-token`) | M2M entre serviços | Keyring por emissor, `kid`, audience, scopes, service binding e TTL máximo de 30min |
| **pgcrypto crypt()** | Verificação de senha | Cost factor 6 (baixo), sem lockout, sem MFA |
| **icingaweb_user** | Fonte de identidade | Schema IcingaWeb2, sem email, sem tenant_id |
| **icingaweb_group_membership** | RBAC (admin vs operator) | Binário apenas, sem roles customizadas |

### 2.3 Serviços e Seus Mecanismos

| Serviço | Suporta Session? | Suporta JWT? | Observação |
|---|---|---|---|
| API | Sim | Sim (verifica com PUBLIC_KEY) | Único que gerencia sessões |
| Discovery | Não | Sim (verifica com PUBLIC_KEY) | `requireAuthOpt` permite acesso parcial sem auth |
| Worker | Não | Sim (assina com PRIVATE_KEY) | Chama API com JWT |
| AI | Não | Sim (verifica com PUBLIC_KEY) | Apenas `requireJwt` |
| Agent | Não | Sim (assina com PRIVATE_KEY) | Envia eventos para API com JWT |

---

## 3. Arquitetura Alvo (@results/auth)

### 3.1 Diagrama de Fluxo Alvo

```
┌──────────────────────────────────────────────────────────────────────┐
│               AUTENTICAÇÃO ALVO (@results/auth)                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Usuário (Browser)                                                   │
│       │                                                              │
│       │ POST /observe/api/auth/login                                 │
│       ▼                                                              │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                   @results/auth                              │    │
│  │                                                               │    │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐  │    │
│  │  │  Auth    │──▶│ Session  │──▶│   RBAC   │──▶│  Audit   │  │    │
│  │  │  Engine  │   │ Manager  │   │  Engine  │   │  Logger  │  │    │
│  │  └──────────┘   └──────────┘   └──────────┘   └──────────┘  │    │
│  │                                                               │    │
│  │  Adapter: ObserveAdapter (api/src/auth/observe-adapter.js)   │    │
│  │    - findUserByUsername() → icingaweb_user                    │    │
│  │    - verifyPassword()      → pgcrypto crypt()                 │    │
│  │    - createSession()       → observe_sessions                 │    │
│  │    - destroySession()      → DELETE observe_sessions           │    │
│  │    - loadAllSessions()     → SELECT observe_sessions           │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Serviço Interno (M2M)                                              │
│       │                                                              │
│       │ Header: Authorization: Bearer <service-token>                │
│       ▼                                                              │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  @results/auth → validateServiceToken(token)                 │    │
│  │  - Tokens de serviço com escopo e TTL gerenciados             │    │
│  │  - Rotação automática                                         │    │
│  │  - Audit log em todas as chamadas M2M                         │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 Mudanças Estruturais

| Componente Atual | Componente Alvo | Ação |
|---|---|---|
| `api/src/jwt.js` | `@results/auth` service tokens | Remover |
| `api/src/middleware/auth.js` (sessionHash, setSessionCookie) | `@results/auth` session manager | Remover |
| `discovery/src/jwt.js` | `@results/auth` middleware | Remover |
| `ai/src/jwt.js` | `@results/auth` middleware | Remover |
| `agent/src/jwt.js` | `@results/auth` client | Remover |
| `worker/src/jwt.js` | `@results/auth` client | Remover |
| `api/src/auth/observe-adapter.js` | Manter — é o adapter para @results/auth | Manter e expandir |
| Login via `api/src/index.js` inline | `@results/auth` login handler | Migrar |

---

## 4. RBAC (Role-Based Access Control)

### 4.1 Modelo Atual

```
┌────────────┐     ┌────────────┐
│   admin    │     │  operator  │
│ (irrestrito)│     │ (limitado) │
└────────────┘     └────────────┘
```

- **admin**: membro do grupo `Administrators` no IcingaWeb2
- **operator**: qualquer usuário autenticado

### 4.2 Modelo Alvo

```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│  admin   │  │ operator │  │ viewer   │  │ auditor  │
│ CRUD all │  │ CRUD own │  │ read-only│  │ logs only│
└──────────┘  └──────────┘  └──────────┘  └──────────┘
                    │
            ┌───────┼───────┐
            │               │
      ┌──────────┐   ┌──────────┐
      │ tenant   │   │ tenant   │
      │  admin   │   │ operator │
      └──────────┘   └──────────┘
```

Roles:
- **admin**: Acesso total à plataforma
- **operator**: Gerenciar recursos do tenant (hosts, serviços, políticas)
- **viewer**: Apenas leitura (dashboards, status)
- **auditor**: Acesso a logs e relatórios de auditoria
- **tenant_admin**: Admin restrito a um tenant específico
- **tenant_operator**: Operator restrito a um tenant

---

## 5. Sessões

### 5.1 Estado Atual

- Tabela: `observe_sessions`
- Colunas: `token_hash` (SHA256), `username`, `role`, `user_agent`, `ip`, `expires_at`, `created_at`, `last_seen_at`
- Cookie: `observe_session` (httpOnly, sameSite=lax, secure condicional)
- TTL: Configurável via `OBSERVE_SESSION_TTL_HOURS` (default 12h)

### 5.2 Estado Alvo

- Gerenciado por `@results/auth` SessionManager
- Tokens opacos (não JWT) com hash server-side
- Suporte a refresh tokens
- Invalidação em cascata (logout all devices)
- Session fingerprint (IP + User-Agent)

---

## 6. Multi-Tenancy

### 6.1 Estado Atual

- Coluna `tenant_id` existe em tabelas principais
- Valor default: `'default'`
- Sem isolamento real — queries usam `WHERE tenant_id = $1` manualmente
- Sem Row-Level Security (RLS) no PostgreSQL

### 6.2 Estado Alvo

- PostgreSQL Row-Level Security por tenant
- Connection pooling com tenant context
- `@results/auth` gerencia `tenant_id` no token/sessão
- Middleware extrai `tenant_id` e injeta no contexto da request

---

## 7. Dependências

### 7.1 Atual

```
jsonwebtoken (^9.0.3) — em TODOS os serviços
@results/auth (file:../../../packages/auth) — apenas api
```

### 7.2 Alvo

```
@results/auth (^1.0.0) — api, discovery, ai
@results/auth-client (^1.0.0) — worker, agent
```

Remover `jsonwebtoken` de TODOS os `package.json`.

---

## 8. Plano de Migração

### Fase 1: Preparação (1 dia)
- [x] Criar `ObserveAdapter` para `@results/auth`
- [ ] Publicar `@results/auth` como pacote interno (npm registry ou tgz)
- [ ] Atualizar `package.json` da API para referência correta

### Fase 2: API (2 dias)
- [ ] Substituir login handler inline por `@results/auth` login
- [ ] Substituir `sessionHash`/`setSessionCookie` pelo SessionManager
- [ ] Substituir `requireAuth` pelo middleware de `@results/auth`
- [ ] Manter compatibilidade temporária com JWT interno (fase de transição)

### Fase 3: Serviços internos (1 dia)
- [ ] Substituir `requireJwt` nos serviços (discovery, ai)
- [ ] Substituir `signInternalToken` nos serviços (worker, agent)
- [ ] Configurar service tokens em `@results/auth`

### Fase 4: Limpeza (1 dia)
- [ ] Remover `jsonwebtoken` de todos os `package.json`
- [ ] Remover `api/src/jwt.js`, `discovery/src/jwt.js`, etc.
- [ ] Rodar teste de regressão completo

---

## 9. Endpoints de Autenticação

### 9.1 Atuais

| Método | Path | Auth | Descrição |
|---|---|---|---|
| POST | `/observe/api/auth/login` | None | Login com user/password |
| POST | `/observe/api/auth/logout` | Session | Logout |
| GET | `/observe/api/auth/me` | Session | Dados do usuário logado |

### 9.2 Futuros (via @results/auth)

| Método | Path | Auth | Descrição |
|---|---|---|---|
| POST | `/observe/api/auth/login` | None | Login |
| POST | `/observe/api/auth/logout` | Session | Logout |
| GET | `/observe/api/auth/me` | Session | Perfil |
| POST | `/observe/api/auth/refresh` | Session | Refresh token |
| POST | `/observe/api/auth/mfa/setup` | Session | Setup MFA |
| POST | `/observe/api/auth/mfa/verify` | Session | Verificar MFA |
| GET | `/observe/api/auth/sessions` | Session | Listar sessões ativas |
| DELETE | `/observe/api/auth/sessions/:id` | Session | Revogar sessão |

---

*Documento gerado pela auditoria técnica — 2026-06-15*
