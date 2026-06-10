/**
 * Usuários da API Icinga2
 * Gerado via entrypoint.sh a partir de variáveis de ambiente.
 *
 * ATENÇÃO: Não edite este arquivo manualmente em produção.
 * Defina ICINGA_API_USER e ICINGA_API_PASSWORD no .env.observe antes do deploy.
 *
 * O usuário root é criado SOMENTE se ICINGA_ROOT_PASSWORD estiver definido
 * (lógica no entrypoint.sh). Senha vazia nunca gera usuário root.
 */

/* Usuário para IcingaWeb2 e R-Observe API */
object ApiUser "${ICINGA_API_USER}" {
  password = "${ICINGA_API_PASSWORD}"
  permissions = [ "*" ]
}
