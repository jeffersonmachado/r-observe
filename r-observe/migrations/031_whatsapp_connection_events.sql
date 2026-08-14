-- Log persistente de eventos de conexão WhatsApp (canais 'qr' e 'cloud').
-- Ciclo de vida do canal QR (service_started, command_applied, qr_generated,
-- status_changed, ready, error, lock_cleared), solicitações vindas da API
-- (connect_requested/disconnect_requested) e resultados de envio
-- (send_qr_*, send_cloud_*). Observabilidade apenas — não altera fluxos.
-- Sem CHECK em channel/event: o helper de auditoria já normaliza os valores e
-- um CHECK rígido exigiria migration nova a cada evento/canal adicionado
-- (lição da constraint de kind da 030).
CREATE TABLE IF NOT EXISTS observe_whatsapp_connection_events (
  id            BIGSERIAL PRIMARY KEY,
  channel       TEXT NOT NULL,
  connection_id TEXT NOT NULL DEFAULT 'default',
  event         TEXT NOT NULL,
  detail        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connection_events_created_at
  ON observe_whatsapp_connection_events (created_at DESC);
