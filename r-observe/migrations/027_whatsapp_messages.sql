-- Auditoria de mensagens WhatsApp (controle total do canal).
-- Registra TODAS as mensagens do canal, nas duas direções:
--   in  (webhook_in)            — mensagem recebida da Meta (assinatura válida)
--   out (bot_reply)             — resposta do bot a um comando/pergunta
--   out (incident_notification) — alerta de incidente enviado pelo worker
--   out (test_send)             — mensagem de teste disparada pela UI
-- status: received | sent | failed (com o erro da Meta em `error`, quando houver).
CREATE TABLE IF NOT EXISTS observe_whatsapp_messages (
  id               BIGSERIAL PRIMARY KEY,
  direction        TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  kind             TEXT NOT NULL CHECK (kind IN ('webhook_in', 'bot_reply', 'incident_notification', 'test_send', 'status_callback')),
  phone            TEXT,
  body             TEXT,
  status           TEXT NOT NULL CHECK (status IN ('received', 'sent', 'failed', 'delivered', 'read')),
  error            TEXT,
  meta_message_id  TEXT,
  incident_id      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_created_at
  ON observe_whatsapp_messages (created_at DESC);
