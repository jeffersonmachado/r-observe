# Integração do @results/auth no R-Observe

Data: 2026-06-12

## Resumo

O módulo `@results/auth` (token opaco baseado em Map + PostgreSQL) foi integrado no serviço `r-observe-api`, substituindo o sistema antigo de sessões com hash SHA-256. O sistema M2M (JWT RS256) continua coexistindo — o middleware unificado tenta token opaco primeiro, com fallback para JWT.

## Arquitetura

```
Browser/Cliente
    │  POST /observe/api/auth/login  →  token opaco (64 hex)
    │  Authorization: Bearer <token> →  auth.validateToken() O(1) síncrono
    ▼
┌─────────────────────────────────┐
│  r-observe-api (porta 3000)     │
│  @results/auth                  │
│  ├─ ObserveAdapter (raw SQL)    │
│  ├─ Map em memória (sessions)   │
│  └─ PostgreSQL (persistência)   │
└─────────────────────────────────┘
    │
    │  M2M: x-internal-token / Bearer <jwt>
    │  verifyInternalToken() RS256
    ▼
┌─────────────────────────────────┐
│  r-observe-discovery (3010)     │
│  JWT (próprio, coexiste)        │
│  UI recebe token JWT server-side│
└─────────────────────────────────┘
```

## Arquivos criados/modificados

### 1. `api/src/auth/observe-adapter.js` (NOVO)

Adapter raw-SQL que implementa a interface do `@results/auth`:

| Método | Implementação |
|---|---|
| `findUserByUsername(username)` | `SELECT FROM icingaweb_user` + resolve role via `icingaweb_group_membership` |
| `verifyPassword(user, password)` | `pgcrypto crypt()` nativo do PostgreSQL |
| `createSession(session)` | `INSERT INTO observe_sessions` (token plain-text) |
| `destroySession(token)` | `DELETE FROM observe_sessions WHERE token_hash = $1` |
| `updateLastLogin(userId, now)` | no-op (icingaweb_user não tem last_login) |
| `updateLastActivity(token, now)` | `UPDATE observe_sessions SET last_seen_at = $2` |
| `loadAllSessions()` | `SELECT FROM observe_sessions WHERE expires_at > NOW()` |

**Role resolution:** consulta `icingaweb_group_membership` pelo grupo `Administrators`. Se o usuário pertence ao grupo, role = `admin`; senão, `operator`.

**NOTA:** A coluna `token_hash` da tabela `observe_sessions` armazena o token em plain-text (o nome da coluna é herdado do sistema antigo). O `@results/auth` espera tokens raw, não hasheados.

### 2. `api/src/index.js` (MODIFICADO)

**Boot:**
```js
const { ObserveAdapter } = require('./auth/observe-adapter');
const { createAuth } = require('@results/auth');

const observeAdapter = new ObserveAdapter(db, logger);
const auth = createAuth({
  adapter: observeAdapter,
  tokenExpirationHours: SESSION_TTL_HOURS,  // 12h default
  inactivityTimeoutMinutes: 120,
  maxSessionsPerAgent: 5,
  isSuperAdmin: (user) => user.role === 'admin',
});
await auth.initialize();
```

**Middleware unificado (`requireAuth`):**
1. Extrai token do header `x-internal-token` ou `Authorization: Bearer`
2. Tenta JWT primeiro (`verifyInternalToken`)
3. Se JWT falhar, tenta token opaco (`auth.validateToken`)
4. Se ambos falharem, tenta cookie (`observe_session`)
5. Se tudo falhar → 401

**Rotas de auth:**
- `POST /observe/api/auth/login` — `auth.login()` + cookie + getContactRole
- `GET /observe/api/auth/me` — retorna `{ user: { name, role, auth_type } }`
- `POST /observe/api/auth/logout` — `auth.logout(token)` (cookie ou Bearer)

**Compatibilidade mantida:**
- Cookie `observe_session` para Grafana/IcingaWeb2
- JWT RS256 para M2M (serviços internos)
- Resposta JSON compatível com frontend existente

### 3. `api/package.json` (MODIFICADO)

Adicionado:
```json
"@results/auth": "file:../../../packages/auth"
```

### 4. `api/Dockerfile` (MODIFICADO)

Build context alterado para `..` (parent de `r-observe/`) para acessar `packages/auth/`. O pacote é empacotado via `npm pack` e instalado como `.tgz`.

```dockerfile
COPY packages/auth/  /tmp/auth-src/
RUN mkdir -p /tmp/auth-pkg && cd /tmp/auth-src && npm pack --pack-destination /tmp/auth-pkg && \
    cp /tmp/auth-pkg/results-auth-*.tgz /tmp/auth.tgz
RUN sed -i '/"@results\/auth"/d' /app/package.json && rm -f /app/package-lock.json
RUN npm install --omit=dev && npm install --omit=dev /tmp/auth.tgz
```

### 5. `docker-compose.observe.yml` (MODIFICADO)

Build context do `r-observe-api` alterado:
```yaml
build:
  context: ..
  dockerfile: r-observe/r-observe/api/Dockerfile
```

### 6. `discovery/src/index.js` (MODIFICADO)

- `requireAuth` e `requireAuthOpt` reescritos para usar `verifyInternalToken` diretamente (não depende mais de `requireJwt` que enviava 401 antes de chamar `next()`)
- UI recebe token JWT injetado server-side via `signInternalToken({ sub: 'ui', role: 'admin' })`
- `requireAuthOpt` NÃO bloqueia requests sem token (permite que a UI carregue dados sem autenticação)

### 7. `discovery/src/auth/observe-adapter.js` (COPIADO)

Cópia do adapter — preparado para futura integração completa do `@results/auth` no discovery (requer adicionar a dependência no `package.json` e `Dockerfile` do discovery).

## Fluxo de autenticação

### Login (usuário browser)
```
POST /observe/api/auth/login
Body: { username, password }
  → adapter.findUserByUsername()
  → adapter.verifyPassword() [pgcrypto crypt()]
  → adapter.createSession() [INSERT observe_sessions]
  → setSessionCookie() [cookie observe_session]
  ← { ok: true, token: "<64 hex>", user: { name, role }, expires_at }
```

### Validação (API calls)
```
Authorization: Bearer <token>
  → requireAuth middleware
  → verifyInternalToken(token) [JWT?]
  → auth.validateToken(token) [opaco?]
  → cookie? [observe_session]
  → req.auth = { type, user, role }
```

### M2M (serviço → serviço)
```
x-internal-token: <jwt>
  → verifyInternalToken(token)
  → req.auth = { type: 'jwt', user, role }
```

## Testes

```bash
# Login
curl -X POST http://localhost:3080/observe/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"3eac415bef5acd1a"}'
# → {"ok":true,"token":"b9e9e2ec...","user":{"name":"admin","role":"admin"}}

# Me (token opaco)
curl -H "Authorization: Bearer <token>" \
  http://localhost:3080/observe/api/auth/me
# → {"user":{"name":"admin","role":"admin","auth_type":"session"}}

# Me (JWT M2M)
curl -H "Authorization: Bearer <jwt>" \
  http://localhost:3080/observe/api/auth/me
# → {"user":{"name":"m2m-test","role":"admin","auth_type":"jwt"}}

# Logout
curl -X POST -H "Authorization: Bearer <token>" \
  http://localhost:3080/observe/api/auth/logout
# → {"ok":true}

# Me pós-logout
curl -H "Authorization: Bearer <token>" \
  http://localhost:3080/observe/api/auth/me
# → 401 Unauthorized
```

## Tabelas envolvidas

| Tabela | Uso |
|---|---|
| `icingaweb_user` | Fonte de identidade (username, password_hash, active) |
| `icingaweb_group` | Grupos (PK: name) |
| `icingaweb_group_membership` | Membership (group_name, username) |
| `observe_sessions` | Sessões (token_hash=tokens plain-text, expires_at, last_seen_at) |

## Próximos passos

1. Adicionar `@results/auth` no `r-observe-discovery` (package.json + Dockerfile) para compartilhar o mesmo Map de sessões
2. Adicionar tela de login na UI do discovery
3. Migrar `token_hash` → `token` (renomear coluna para refletir tokens plain-text)
4. Adicionar `last_login_at` na tabela `icingaweb_user`
