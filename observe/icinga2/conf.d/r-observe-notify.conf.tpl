/**
 * Integração Icinga2 → R-Observe API
 *
 * Envia eventos de problema e recuperação para o endpoint
 * POST /observe/api/icinga/events da R-Observe API.
 *
 * Template — ${ICINGA_API_PASSWORD} substituído pelo entrypoint.sh via envsubst.
 * Macros do Icinga2 ($host_name$, $notification_type$, etc.) são resolvidas
 * em tempo de execução pelo daemon.
 */

/* Usuário fictício exigido pelo mecanismo de notificação do Icinga2 */
object User "r-observe" {
  display_name = "R-Observe API"
}

object NotificationCommand "r-observe-notify" {
  command = ["/bin/bash", "/usr/lib/r-observe/notify.sh"]

  env = {
    NOTIFICATION_TYPE = "$notification_type$"
    HOST_NAME         = "$host_name$"
    HOST_STATE        = "$host_state$"
    HOST_ADDRESS      = "$host_address$"
    HOST_OUTPUT       = "$host_output$"
    SERVICE_NAME      = "$service_name$"
    SERVICE_STATE     = "$service_state$"
    SERVICE_OUTPUT    = "$service_output$"
    R_OBSERVE_URL     = "http://r-observe-api:3000"
    R_OBSERVE_TOKEN   = "${ICINGA_API_PASSWORD}"
  }
}

/* Notifica R-Observe em problemas e recuperações de host */
apply Notification "r-observe-host" to Host {
  command = "r-observe-notify"
  users   = ["r-observe"]
  types   = [Problem, Recovery]
  states  = [Down, Up]
  assign where host.name
}

/* Notifica R-Observe em problemas e recuperações de serviço */
apply Notification "r-observe-service" to Service {
  command = "r-observe-notify"
  users   = ["r-observe"]
  types   = [Problem, Recovery]
  states  = [Critical, Warning, OK, Unknown]
  assign where service.name
}
