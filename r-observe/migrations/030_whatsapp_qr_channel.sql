-- Canal WhatsApp via QR Code (whatsapp-web.js, não-oficial) como alternativa à Meta Cloud API.
-- (a) coluna `channel` na auditoria: 'cloud' (padrão, Meta) ou 'qr' (bridge no worker).
-- (b) novo kind 'inbound' para mensagens recebidas pelo canal QR.
-- (c) estado da conexão QR: a API lê/escreve esta tabela; o worker faz poll e
--     executa os comandos (desired_state) — não há canal direto entre os processos.
ALTER TABLE observe_whatsapp_messages
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'cloud';

ALTER TABLE observe_whatsapp_messages
  DROP CONSTRAINT IF EXISTS observe_whatsapp_messages_kind_check;
ALTER TABLE observe_whatsapp_messages
  ADD CONSTRAINT observe_whatsapp_messages_kind_check
  CHECK (kind IN ('webhook_in', 'inbound', 'bot_reply', 'incident_notification', 'test_send', 'status_callback'));

CREATE TABLE IF NOT EXISTS observe_whatsapp_qr_connections (
  id             TEXT PRIMARY KEY,
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  desired_state  TEXT NOT NULL DEFAULT 'disconnected' CHECK (desired_state IN ('connected', 'disconnected')),
  status         TEXT NOT NULL DEFAULT 'disconnected',
  qr_text        TEXT,
  qr_data_url    TEXT,
  qr_expires_at  TIMESTAMPTZ,
  last_error     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO observe_whatsapp_qr_connections (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;
