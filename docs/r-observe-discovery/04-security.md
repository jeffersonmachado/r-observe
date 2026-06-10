# Segurança e controles de scan

- Perfil default: `safe`.
- Perfis disponiveis: `safe`, `balanced`, `aggressive`.
- Guardrails:
  - ranges permitidos (`allowed_ranges`)
  - ranges bloqueados (`blocked_ranges`)
  - limite de taxa (`max_rate_per_minute`)
- API com `helmet` e `express-rate-limit`.
- Controle de token interno por `x-internal-token` quando habilitado.
- Timeouts curtos por probe para evitar bloqueio.

## Politica recomendada de producao

1. `scan_profile = safe`
2. allowlist somente redes internas
3. blacklist para ranges sensiveis
4. habilitar onboarding Icinga apenas com aprovacao (`lifecycle_state`)
